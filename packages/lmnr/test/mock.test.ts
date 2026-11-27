import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import {
  Laminar,
  MockedError,
  observe,
  observeExperimentalDecorator,
} from "../src";
import { MOCK_FAILURE } from "../src/mock";
import { RETRY_BACKOFF_MS, resetMockClient } from "../src/mock/client";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.resolve(dirname, "../../../spec/lmnr-mock");
const PREFIX = "/_lmnr/v1/" + "t".repeat(32);

type Recorded = { method: string; key: string; body: any };

// The SDK blocks this thread while it fetches `/keys`, so the server runs in
// a worker of its own.
const FAKE_SERVER = `
const { createServer } = require("node:http");
const { parentPort } = require("node:worker_threads");
let state = { keys: [], keysStatus: [], replies: {}, delayMs: 0 };
const requests = [];
const send = (res, status, body) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const prefix = process.env.PREFIX;
    if (req.method === "GET") {
      requests.push({ method: "GET", key: req.url, body: null });
      const status = state.keysStatus.length ? state.keysStatus.shift() : 200;
      return send(res, status, status === 200 ? { keys: state.keys } : "busy");
    }
    const key = decodeURIComponent(req.url.slice((prefix + "/fn/").length));
    requests.push({ method: "POST", key, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const [status, body] = state.replies[key].shift();
    setTimeout(() => send(res, status, body), state.delayMs);
  });
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage({ port: server.address().port }));
parentPort.on("message", (message) => {
  if (message.type === "state") state = { ...state, ...message.state };
  if (message.type === "reply") (state.replies[message.key] ??= []).push(message.reply);
  if (message.type === "requests") parentPort.postMessage({ requests });
  if (message.type === "close") server.close(() => process.exit(0));
});
`;

class FakeServer {
  private constructor(
    private readonly worker: Worker,
    readonly url: string,
  ) {}

  static async start(keys: string[]): Promise<FakeServer> {
    const worker = new Worker(FAKE_SERVER, {
      eval: true,
      env: { PREFIX },
      execArgv: [],
    });
    const { port } = await next(worker);
    const server = new FakeServer(worker, `http://127.0.0.1:${port}${PREFIX}`);
    await server.set({ keys });
    return server;
  }

  async set(state: Record<string, unknown>): Promise<void> {
    this.worker.postMessage({ type: "state", state });
    // Round trip, so the state is applied before the next request.
    await this.requests();
  }

  async reply(key: string, status: number, body: unknown): Promise<void> {
    this.worker.postMessage({ type: "reply", key, reply: [status, body] });
    await this.requests();
  }

  respond = (key: string, value: unknown) =>
    this.reply(key, 200, { action: "respond", value });

  async requests(): Promise<Recorded[]> {
    this.worker.postMessage({ type: "requests" });
    return (await next(this.worker)).requests;
  }

  async calls(): Promise<Recorded[]> {
    return (await this.requests()).filter((r) => r.method === "POST");
  }

  async close(): Promise<void> {
    this.worker.postMessage({ type: "close" });
    await new Promise((resolve) => this.worker.once("exit", resolve));
  }
}

const next = (worker: Worker): Promise<any> =>
  new Promise((resolve) => worker.once("message", resolve));

/** A port nothing listens on: bound by a server that is then closed. */
const closedPortUrl = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}${PREFIX}`;
};

const useMockUrl = (url: string | undefined) => {
  if (url === undefined) {
    delete process.env.LMNR_MOCK_URL;
  } else {
    process.env.LMNR_MOCK_URL = url;
  }
  resetMockClient();
};

const rejectsMocked = async (
  promise: Promise<unknown>,
  name: string,
  message: string | RegExp,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MockedError);
    assert.equal(error.name, name);
    if (typeof message === "string") {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }
    return true;
  });
};

void describe("observe mocks", () => {
  const exporter = new InMemorySpanExporter();
  let server: FakeServer;

  void beforeEach(async () => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
    server = await FakeServer.start([
      "crm.get_customer",
      "payments.refund",
      "search.web",
    ]);
    useMockUrl(server.url);
  });

  void afterEach(async () => {
    exporter.reset();
    await server.close();
    useMockUrl(undefined);
    delete process.env.LMNR_MOCK_TIMEOUT_MS;
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  // Off by default

  void it("runs the function and makes no request without LMNR_MOCK_URL", async () => {
    useMockUrl(undefined);
    const result = await observe(
      { name: "crm.get_customer" },
      async () => "real",
    );
    assert.equal(result, "real");
    assert.deepEqual(await server.requests(), []);
  });

  // Outcomes

  void it("returns a respond value and records the span", async () => {
    await server.respond("crm.get_customer", { id: "cus_1" });
    let ran = false;
    const result = await observe(
      { name: "crm.get_customer" },
      async (email: string, options: { plan: string }) => {
        ran = true;
        return { email, options };
      },
      "ana@example.com",
      { plan: "pro" },
    );
    assert.deepEqual(result, { id: "cus_1" });
    assert.equal(ran, false);

    const [call] = await server.calls();
    assert.deepEqual(call.body.args, ["ana@example.com", { plan: "pro" }]);
    assert.equal(call.body.lang, "typescript");

    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes["lmnr.span.mocked"], true);
    assert.equal(span.attributes["lmnr.mock.key"], "crm.get_customer");
    assert.equal(span.attributes["lmnr.mock.outcome"], "respond");
    assert.deepEqual(
      JSON.parse(span.attributes["lmnr.span.output"] as string),
      {
        id: "cus_1",
      },
    );
    assert.deepEqual(JSON.parse(span.attributes["lmnr.span.input"] as string), [
      "ana@example.com",
      { plan: "pro" },
    ]);
    assert.equal(call.body.trace_id, span.spanContext().traceId);
    assert.equal(call.body.span_id, span.spanContext().spanId);
  });

  void it("throws a MockedError named after the raised type", async () => {
    await server.reply("payments.refund", 200, {
      action: "raise",
      error: { type: "DuplicateRefund", message: "already refunded" },
    });
    await rejectsMocked(
      observe({ name: "payments.refund" }, async () => {
        throw new Error("the real function ran");
      }),
      "DuplicateRefund",
      "already refunded",
    );
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes["lmnr.span.mocked"], true);
    assert.equal(span.attributes["lmnr.mock.outcome"], "raise");
    const [event] = span.events;
    assert.equal(event.name, "exception");
    assert.equal(event.attributes?.["exception.type"], "DuplicateRefund");
    assert.equal(event.attributes?.["exception.message"], "already refunded");
  });

  void it("runs the real function on passthrough", async () => {
    await server.reply("search.web", 200, { action: "passthrough" });
    const result = await observe(
      { name: "search.web" },
      async (q: string) => `real ${q}`,
      "weather",
    );
    assert.equal(result, "real weather");
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes["lmnr.span.mocked"], undefined);
    assert.equal(span.attributes["lmnr.mock.outcome"], "passthrough");
    assert.equal(span.attributes["lmnr.span.output"], '"real weather"');
  });

  const failures: [number, unknown, string][] = [
    [
      500,
      {
        action: "handler_error",
        error: { type: "ValueError", message: "broken" },
      },
      "crm.get_customer: the mock handler raised ValueError: broken",
    ],
    [
      404,
      { error: { type: "UnknownMockKey", message: "no function mock" } },
      "crm.get_customer: the mock server answered 404 UnknownMockKey: no function mock",
    ],
    [
      400,
      { error: { type: "BadRequest", message: "expected args" } },
      "crm.get_customer: the mock server answered 400 BadRequest: expected args",
    ],
    [
      200,
      { action: "respond" },
      'crm.get_customer: unexpected mock server response [200] {"action":"respond"}',
    ],
    [
      200,
      "not json",
      "crm.get_customer: unexpected mock server response [200] not json",
    ],
    [
      502,
      "",
      "crm.get_customer: unexpected mock server response [502] <empty body>",
    ],
  ];
  for (const [status, body, message] of failures) {
    void it(`fails on ${status} ${JSON.stringify(body)}`, async () => {
      await server.reply("crm.get_customer", status, body);
      let ran = false;
      await rejectsMocked(
        observe({ name: "crm.get_customer" }, async () => {
          ran = true;
        }),
        MOCK_FAILURE,
        message,
      );
      assert.equal(ran, false);
      const [span] = exporter.getFinishedSpans();
      assert.equal(span.attributes["lmnr.mock.outcome"], "error");
      assert.equal(span.attributes["lmnr.span.mocked"], undefined);
    });
  }

  void it("times out a slow server", async () => {
    process.env.LMNR_MOCK_TIMEOUT_MS = "200";
    useMockUrl(server.url);
    await server.set({ delayMs: 2000 });
    await server.respond("crm.get_customer", 1);
    const started = Date.now();
    await rejectsMocked(
      observe({ name: "crm.get_customer" }, async () => 0),
      MOCK_FAILURE,
      /^crm\.get_customer: mock server unreachable \(Error: timed out after 200 ms\)$/,
    );
    assert.ok(Date.now() - started < 1500);
  });

  // Keys

  void it("uses mockKey, then the name, then the function name", async () => {
    await server.set({ keys: ["by_mock_key", "by_name", "byFunctionName"] });
    for (const key of ["by_mock_key", "by_name", "byFunctionName"]) {
      await server.respond(key, key);
    }
    const byFunctionName = async () => "real";
    assert.equal(
      await observe(
        { name: "by_name", mockKey: "by_mock_key" },
        async () => "real",
      ),
      "by_mock_key",
    );
    assert.equal(
      await observe({ name: "by_name" }, async () => "real"),
      "by_name",
    );
    assert.equal(await observe({}, byFunctionName), "byFunctionName");
  });

  void it("runs unmocked keys and fetches the keys once", async () => {
    const add = (x: number) => x + 1;
    assert.equal(observe({ name: "not.mocked" }, add, 1), 2);
    assert.equal(await observe({ name: "other" }, async () => 3), 3);
    assert.deepEqual(await server.requests(), [
      { method: "GET", key: PREFIX + "/keys", body: null },
    ]);
  });

  void it("never consults the server for mockable: false", async () => {
    assert.equal(
      await observe(
        { name: "crm.get_customer", mockable: false },
        async () => "real",
      ),
      "real",
    );
    assert.deepEqual(await server.requests(), []);
  });

  void it("fails closed while the server is unreachable, then retries after a backoff", async () => {
    useMockUrl(await closedPortUrl());
    // Sync functions throw, async ones reject.
    assert.throws(
      () => observe({ name: "anything" }, () => "real"),
      (error: unknown) =>
        error instanceof MockedError &&
        /^mock server unreachable \(Error: connect ECONNREFUSED/.test(
          error.message,
        ),
    );

    useMockUrl(server.url);
    await server.set({ keysStatus: [503] });
    await rejectsMocked(
      observe({ name: "anything" }, async () => "real"),
      MOCK_FAILURE,
      /^mock server unreachable \(GET \/keys answered \[503\] busy\)$/,
    );
    // Inside the backoff: no request.
    await rejectsMocked(
      observe({ name: "anything" }, async () => "real"),
      MOCK_FAILURE,
      /^mock server unreachable/,
    );
    assert.equal((await server.requests()).length, 1);
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS + 50));
    assert.equal(
      await observe({ name: "anything" }, async () => "real"),
      "real",
    );
    assert.equal((await server.requests()).length, 2);
  });

  void it("never puts the token in errors", async () => {
    useMockUrl(await closedPortUrl());
    await assert.rejects(
      observe({ name: "anything" }, async () => "real"),
      (error: Error) => !error.message.includes("t".repeat(32)),
    );
  });

  // Function shapes

  void it("refuses to mock a function that isn't async", async () => {
    const message =
      "crm.get_customer: mocked TypeScript functions must return a Promise " +
      "(declare the function async)";
    let ran = false;
    assert.throws(
      () =>
        observe({ name: "crm.get_customer" }, () => {
          ran = true;
          return "sync";
        }),
      { name: MOCK_FAILURE, message },
    );
    // A plain function returning a Promise can't be told apart before it runs.
    assert.throws(
      () =>
        observe({ name: "crm.get_customer" }, () => {
          ran = true;
          return Promise.resolve("promise");
        }),
      { name: MOCK_FAILURE, message },
    );
    assert.equal(ran, false);
    assert.deepEqual(await server.calls(), []);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.events[0].name, "exception");
  });

  void it("refuses to mock generators and leaves unmocked ones alone", async () => {
    function* gen() {
      yield 1;
    }
    async function* agen() {
      yield 1;
    }
    for (const fn of [gen, agen]) {
      assert.throws(() => observe({ name: "crm.get_customer" }, fn), {
        name: MOCK_FAILURE,
        message: "crm.get_customer: generators can't be mocked yet",
      });
    }
    assert.deepEqual([...observe({ name: "unmocked" }, gen)], [1]);
  });

  // Only the experimental flavour: this package's tsconfig turns on
  // `experimentalDecorators`, and `observeDecorator` resolves the key the same way.
  void it("mocks decorated methods", async () => {
    await server.respond("search.web", "mocked");

    class Service {
      @observeExperimentalDecorator({ name: "other", mockKey: "search.web" })
      async search(q: string): Promise<string> {
        return `real ${q}`;
      }

      @observeExperimentalDecorator({ name: "search.web", mockable: false })
      async unmockable(q: string): Promise<string> {
        return `real ${q}`;
      }
    }
    assert.equal(await new Service().search("q"), "mocked");
    assert.equal(await new Service().unmockable("q"), "real q");
    assert.deepEqual(
      (await server.calls()).map((c) => [c.key, c.body.args]),
      [["search.web", ["q"]]],
    );
  });

  void it("works without Laminar.initialize", async () => {
    trace.disable();
    _resetConfiguration();
    Object.defineProperty(Laminar, "isInitialized", { value: false });
    await server.respond("crm.get_customer", "mocked");
    assert.equal(
      await observe({ name: "crm.get_customer" }, async () => "real"),
      "mocked",
    );
  });

  void it("exports MockedError", () => {
    const error = new MockedError("Kind", "message");
    assert.ok(error instanceof Error);
    assert.equal(String(error), "Kind: message");
  });
});

// Conformance cases (spec/lmnr-mock/cases): the recorded responses, served
// back; the SDK must do what each call's `sdk` says.
void describe("lmnr-mock conformance", () => {
  const cases = path.join(SPEC_DIR, "cases");
  const mapping = JSON.parse(
    readFileSync(path.join(cases, "mocks.json"), "utf8"),
  );
  const files = readdirSync(cases).filter(
    (f) => f.endsWith(".json") && f !== "mocks.json",
  );

  void afterEach(() => useMockUrl(undefined));

  for (const file of files) {
    void it(file, async () => {
      const scenario = JSON.parse(readFileSync(path.join(cases, file), "utf8"));
      assert.ok(scenario.description);
      const calls = scenario.calls.filter(
        (call: any) =>
          call.path.startsWith("/fn/") &&
          // This SDK always sends args, and only for listed keys.
          "args" in call.body &&
          decodeURIComponent(call.path.slice(4)) in mapping,
      );
      const server = await FakeServer.start(Object.keys(mapping));
      useMockUrl(server.url);
      try {
        for (const call of calls) {
          const key = decodeURIComponent(call.path.slice(4));
          await server.reply(key, call.status, call.response);
          const sent = call.body.args;
          const args = Array.isArray(sent) ? sent : [sent];
          let ran = false;
          const result = observe(
            { name: key },
            async (..._args: unknown[]) => {
              ran = true;
              return "real";
            },
            ...args,
          );
          const expected = call.sdk;
          if ("returns" in expected) {
            assert.deepEqual(await result, expected.returns);
            assert.equal(ran, false);
          } else if ("raises" in expected) {
            await rejectsMocked(
              result,
              expected.raises.type,
              expected.raises.message,
            );
            assert.equal(ran, false);
          } else if ("calls_real_function" in expected) {
            assert.equal(await result, "real");
            assert.equal(ran, true);
          } else {
            assert.deepEqual(expected, { fails: true });
            await rejectsMocked(result, MOCK_FAILURE, /./);
            assert.equal(ran, false);
          }
          const recorded = (await server.calls()).pop();
          assert.deepEqual(recorded?.body.args, args);
          if (call.body.lang === "typescript") {
            assert.deepEqual(recorded?.body.args, call.body.args);
          }
        }
      } finally {
        await server.close();
      }
    });
  }
});
