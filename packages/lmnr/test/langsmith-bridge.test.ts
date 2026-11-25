/**
 * LangSmith → Laminar bridge (`Laminar.initialize({ bridges: ["langsmith"] })`)
 * on the langsmith devDependency (pinned). LangSmith's HTTP goes through the
 * client's `fetchImplementation`, LLM HTTP through a mocked `fetch`.
 *
 * - "ids": span / trace ids, with vectors computed by lmnr-python's
 *   `span_id_for` / `trace_id_for` (they must agree byte for byte).
 * - "fixtures": `langsmith-bridge/fixtures/js-sdk-payloads.json` (what
 *   langsmith 0.14.0 handed to `Client.createRun` / `updateRun` for
 *   `traceable`, `wrapOpenAI`, LangChain and LangGraph) replayed through the
 *   recorder.
 * - "live": the real SDK end to end.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { RunnableLambda } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { ChatOpenAI } from "@langchain/openai";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { Client, overrideFetchImplementation } from "langsmith";
import { RunTree } from "langsmith/run_trees";
import { traceable } from "langsmith/traceable";
import { z } from "zod";

import { Laminar, LaminarSpanProcessor, observe } from "../src/index";
import { LangSmithBridge } from "../src/opentelemetry-lib/bridges/langsmith";
import {
  LangSmithRunRecorder,
  spanIdFor,
  traceIdFor,
} from "../src/opentelemetry-lib/bridges/langsmith/runs";
import {
  LangSmithTap,
  langsmithCopies,
} from "../src/opentelemetry-lib/bridges/langsmith/tap";
import {
  associationAttributes,
  exceptionAttributes,
  isGlueRun,
} from "../src/opentelemetry-lib/bridges/langsmith/translate";
import { _configuration } from "../src/opentelemetry-lib/configuration";
import { LaminarContextManager } from "../src/opentelemetry-lib/tracing/context";

// ---------------------------------------------------------------------------
// Pipelines and mocks
// ---------------------------------------------------------------------------

const laminarExporter = new InMemorySpanExporter();

const initLaminar = (props: Record<string, unknown> = {}) =>
  Laminar.initialize({
    projectApiKey: "test",
    spanProcessor: new LaminarSpanProcessor({
      exporter: laminarExporter,
      disableBatch: true,
    }),
    bridges: ["langsmith"],
    ...props,
  });

const lmSpans = () => laminarExporter.getFinishedSpans();
const byName = (name: string, spans = lmSpans()): ReadableSpan => {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `no span named ${name} in ${spans.map((s) => s.name)}`);
  return span;
};
const parentId = (span: ReadableSpan): string | undefined =>
  (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;
const json = (span: ReadableSpan, key: string): unknown => {
  const value = span.attributes[key];
  assert.strictEqual(typeof value, "string", `${span.name} has no ${key}`);
  return JSON.parse(value as string);
};

interface LangSmithRequest {
  method: string;
  path: string;
  body: unknown;
}

/** A real `Client` whose HTTP is recorded instead of sent. */
const langsmithClient = (options: Record<string, unknown> = {}) => {
  const requests: LangSmithRequest[] = [];
  const fetchImplementation = async (url: any, init?: any) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith("/info")) {
      return Response.json({
        batch_ingest_config: { use_multipart_endpoint: true },
      });
    }
    let body: unknown;
    const contentType = new Headers(init?.headers).get("content-type") ?? "";
    if (contentType.startsWith("multipart/")) {
      const form = await new Response(init.body, {
        headers: { "content-type": contentType },
      }).formData();
      const parts: [string, unknown][] = [];
      for (const [name, value] of form.entries()) {
        const text = typeof value === "string" ? value : await value.text();
        parts.push([name, JSON.parse(text)]);
      }
      body = parts;
    } else if (init?.body !== undefined) {
      body = JSON.parse(new TextDecoder().decode(init.body));
    }
    requests.push({ method: init?.method ?? "GET", path: pathname, body });
    return Response.json({});
  };
  const client = new Client({
    apiUrl: "http://langsmith.test",
    apiKey: "ls-test",
    fetchImplementation: fetchImplementation as typeof fetch,
    ...options,
  });
  // langsmith < 0.3.87 has no `fetchImplementation` option, only the global
  // override. Clients are used one at a time, so it can follow the newest.
  if (!("fetchImplementation" in client)) {
    overrideFetchImplementation(fetchImplementation as typeof fetch);
  }
  const settle = async () => {
    await awaitAllCallbacks();
    await client.awaitPendingTraceBatches();
  };
  return { client, requests, settle };
};

/**
 * LangSmith's requests with run ids replaced by their order of appearance and
 * wall-clock values dropped.
 */
const normalizeRequests = (requests: LangSmithRequest[]): unknown => {
  const ids = new Map<string, string>();
  const text = JSON.stringify(requests)
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (id) => {
        if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
        return ids.get(id)!;
      },
    )
    .replace(/\d{8}T\d{6,}Z/g, "<t>")
    .replace(/"(start_time|end_time)":("[^"]*"|\d+(\.\d+)?)/g, '"$1":"<t>"')
    .replace(/"time":("[^"]*"|\d+(\.\d+)?)/g, '"time":"<t>"');
  return JSON.parse(text);
};

const chatCompletion = (body: any) => {
  const withTools =
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    body.messages?.[body.messages.length - 1]?.role !== "tool";
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: withTools ? "tool_calls" : "stop",
        message: withTools
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                  },
                },
              ],
            }
          : { role: "assistant", content: "Sunny" },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
};

const mockLlmFetch = async (_url: any, init?: any): Promise<Response> =>
  Response.json(
    chatCompletion(init?.body ? JSON.parse(String(init.body)) : {}),
  );

/** A two-level `traceable` workload, plus a failing run. */
const traceableWorkload = async (client: Client) => {
  const llm = traceable(
    async (_messages: unknown) => ({
      role: "assistant",
      content: "Paris is sunny",
      usage_metadata: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }),
    {
      name: "fake_llm",
      run_type: "llm",
      client,
      tracingEnabled: true,
      metadata: { ls_provider: "openai", ls_model_name: "gpt-4o-mini" },
    },
  );
  const chain = traceable(
    async (question: string) => {
      const reply = await llm([{ role: "user", content: question }]);
      return { answer: reply.content };
    },
    {
      name: "qa_chain",
      client,
      tracingEnabled: true,
      tags: ["prod"],
      metadata: { session_id: "sess-1", user_id: "u1", tenant: "acme" },
    },
  );
  const boom = traceable(
    async (_x: string) => {
      throw new Error("kaboom");
    },
    { name: "boom", client, tracingEnabled: true },
  );
  await chain("Weather in Paris?");
  await boom("y").catch(() => undefined);
};

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

void describe("LangSmith bridge ids", () => {
  // From lmnr-python: `format(span_id_for(s), "016x")`,
  // `format(trace_id_for(s), "032x")`.
  const vectors: [string, string, string | undefined][] = [
    [
      "01a2129d-b541-77ac-aade-37d30540952d",
      "97748be6599f79d0",
      "01a2129db54177acaade37d30540952d",
    ],
    [
      "01A2129D-B545-736C-B2DC-FB03A67FCF08",
      "e6c0b64c4b5db465",
      "01a2129db545736cb2dcfb03a67fcf08",
    ],
    [
      "00000000-0000-0000-0000-000000000000",
      "7c384c6218f299f1",
      "00000000000000000000000000000001",
    ],
    ["not-a-uuid", "e287cc0c0ba2f0c0", "0000000000000000e287cc0c0ba2f0c0"],
    ["", "cbf29ce484222325", undefined],
  ];

  void it("matches lmnr-python's span_id_for / trace_id_for", () => {
    for (const [input, spanId, traceId] of vectors) {
      assert.strictEqual(spanIdFor(input), spanId, input);
      if (traceId) assert.strictEqual(traceIdFor(input), traceId, input);
    }
  });
});

// ---------------------------------------------------------------------------
// translation
// ---------------------------------------------------------------------------

void describe("LangSmith bridge translation", () => {
  void it("keeps only the root run's own metadata", () => {
    const metadata = {
      session_id: "s",
      user_id: 42,
      tenant: "acme",
      ls_provider: "openai",
      versions: { "@langchain/core": "1.0.0" },
      LANGSMITH_PROJECT: "p",
      model: "gpt-4o-mini",
      nested: { a: 1 },
    };
    assert.deepStrictEqual(
      associationAttributes(
        metadata,
        ["seq:step:1", "graph:step:2", "langsmith:hidden", "prod", "prod"],
        true,
        { model: "gpt-4o-mini" },
      ),
      {
        "lmnr.association.properties.session_id": "s",
        "lmnr.association.properties.user_id": "42",
        "lmnr.association.properties.tags": ["prod"],
        "lmnr.association.properties.metadata.tenant": "acme",
        "lmnr.association.properties.metadata.nested": '{"a":1}',
      },
    );
    assert.deepStrictEqual(associationAttributes(metadata, [], false), {
      "lmnr.association.properties.session_id": "s",
      "lmnr.association.properties.user_id": "42",
    });
  });

  void it("parses JS and Python error strings", () => {
    assert.deepStrictEqual(exceptionAttributes("Error: kaboom: y"), {
      "exception.type": "Error",
      "exception.message": "kaboom: y",
    });
    assert.deepStrictEqual(
      exceptionAttributes(
        "ValueError('bad')\n\nTraceback (most recent call last):\n  x",
      ),
      {
        "exception.type": "ValueError",
        "exception.message": "bad",
        "exception.stacktrace": "Traceback (most recent call last):\n  x",
      },
    );
    assert.deepStrictEqual(exceptionAttributes("something broke"), {
      "exception.type": "Error",
      "exception.message": "something broke",
    });
  });

  void it("treats unnamed LangChain sequences and hidden runs as glue", () => {
    assert.ok(isGlueRun("RunnableSequence", [], true));
    assert.ok(!isGlueRun("RunnableSequence", [], false));
    assert.ok(isGlueRun("anything", ["langsmith:hidden"], false));
    assert.ok(!isGlueRun("my_node", [], true));
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type FixtureRecord = {
  op: "create" | "update";
  args: { run: Record<string, any>; runId?: string };
};
const fixtures: Record<string, FixtureRecord[]> = JSON.parse(
  readFileSync(
    join(__dirname, "langsmith-bridge", "fixtures", "js-sdk-payloads.json"),
    "utf8",
  ),
);

/** Feed one recorded workload to a recorder, as the tap would. */
const replay = (name: string): ReadableSpan[] => {
  laminarExporter.reset();
  const recorder = new LangSmithRunRecorder();
  for (const { op, args } of fixtures[name]) {
    const run = structuredClone(args.run);
    if (op === "create") recorder.onCreate(run, ROOT_CONTEXT, "0.14.0");
    else recorder.onUpdate({ ...run, id: args.runId }, "0.14.0");
  }
  return lmSpans();
};

void describe("LangSmith bridge fixtures (langsmith 0.14.0)", () => {
  beforeEach(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
    initLaminar({ bridges: [] });
  });

  after(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
  });

  void it("traceable: nested LLM run, session, user, tags", () => {
    const spans = replay("a_traceable_nested_llm");
    assert.deepStrictEqual(spans.map((s) => s.name).sort(), [
      "fake_llm",
      "qa_chain",
    ]);
    const chain = byName("qa_chain", spans);
    const llm = byName("fake_llm", spans);
    assert.strictEqual(parentId(llm), chain.spanContext().spanId);
    assert.strictEqual(parentId(chain), undefined);
    const runId = chain.attributes["langsmith.run.id"] as string;
    assert.strictEqual(chain.spanContext().spanId, spanIdFor(runId));
    assert.strictEqual(chain.spanContext().traceId, traceIdFor(runId));
    assert.deepStrictEqual(chain.attributes["lmnr.span.path"], ["qa_chain"]);
    assert.deepStrictEqual(llm.attributes["lmnr.span.path"], [
      "qa_chain",
      "fake_llm",
    ]);
    assert.deepStrictEqual(llm.attributes["lmnr.span.ids_path"], [
      ...(chain.attributes["lmnr.span.ids_path"] as string[]),
      `00000000-0000-0000-${llm.spanContext().spanId.slice(0, 4)}-${llm.spanContext().spanId.slice(4)}`,
    ]);

    assert.strictEqual(chain.attributes["lmnr.span.type"], "DEFAULT");
    assert.strictEqual(chain.attributes["lmnr.span.bridge.name"], "langsmith");
    assert.strictEqual(chain.attributes["lmnr.span.bridge.version"], "0.14.0");
    assert.strictEqual(chain.attributes["langsmith.run.type"], "chain");
    assert.deepStrictEqual(json(chain, "lmnr.span.input"), {
      input: "Weather in Paris?",
    });
    assert.deepStrictEqual(json(chain, "lmnr.span.output"), {
      answer: "Paris is sunny",
    });
    // `session_id` wins over `thread_id`, as in LangSmith's UI.
    assert.strictEqual(
      chain.attributes["lmnr.association.properties.session_id"],
      "sess-123",
    );
    assert.strictEqual(
      chain.attributes["lmnr.association.properties.user_id"],
      "u1",
    );
    assert.deepStrictEqual(
      chain.attributes["lmnr.association.properties.tags"],
      ["prod", "qa"],
    );

    assert.strictEqual(llm.attributes["lmnr.span.type"], "LLM");
    assert.deepStrictEqual(json(llm, "gen_ai.input.messages"), [
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.deepStrictEqual(json(llm, "gen_ai.output.messages"), [
      { role: "assistant", content: "Paris is sunny" },
    ]);
    assert.strictEqual(llm.attributes["gen_ai.request.model"], "gpt-4o-mini");
    assert.strictEqual(llm.attributes["gen_ai.system"], "openai");
    assert.strictEqual(llm.attributes["gen_ai.request.temperature"], 0.2);
    assert.strictEqual(llm.attributes["gen_ai.usage.input_tokens"], 12);
    assert.strictEqual(llm.attributes["gen_ai.usage.output_tokens"], 4);
    assert.strictEqual(llm.attributes["llm.usage.total_tokens"], 16);
    // Trace metadata comes from the root run only.
    assert.ok(
      !Object.keys(llm.attributes).some((k) =>
        k.startsWith("lmnr.association.properties.metadata."),
      ),
    );
    // End is epoch ms, start an ISO string; both make it to the span.
    assert.ok(chain.duration[0] >= 0 && chain.duration[1] >= 0);
  });

  void it("wrapOpenAI: a tool call turn hashes the same in output and next input", () => {
    const spans = replay("b_wrap_openai_tools");
    const calls = spans
      .filter((s) => s.name === "ChatOpenAI")
      .sort(
        (a, b) =>
          a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1],
      );
    assert.strictEqual(calls.length, 2);
    const [first, second] = calls;
    const output = json(first, "gen_ai.output.messages") as unknown[];
    assert.deepStrictEqual(output, [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_abc123",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
        ],
      },
    ]);
    const input = json(second, "gen_ai.input.messages") as unknown[];
    assert.deepStrictEqual(input[1], output[0]);
    assert.deepStrictEqual(input[2], {
      role: "tool",
      content: "sunny, 22C",
      tool_call_id: "call_abc123",
    });
    assert.deepStrictEqual(
      (json(first, "gen_ai.tool.definitions") as any[])[0].function.name,
      "get_weather",
    );
    assert.strictEqual(
      first.attributes["gen_ai.response.model"],
      "gpt-4o-mini",
    );
    assert.strictEqual(first.attributes["gen_ai.response.id"], "chatcmpl-1");
    assert.strictEqual(first.attributes["gen_ai.usage.input_tokens"], 11);
    const agent = byName("tool_agent", spans);
    assert.strictEqual(parentId(first), agent.spanContext().spanId);
  });

  void it("wrapOpenAI stream: the reduced completion and usage", () => {
    const [span] = replay("c_wrap_openai_stream");
    assert.deepStrictEqual(json(span, "gen_ai.output.messages"), [
      { role: "assistant", content: "Hello world" },
    ]);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 7);
    assert.strictEqual(
      span.attributes["gen_ai.response.id"],
      "chatcmpl-stream1",
    );
  });

  void it("LangChain: serialized messages, invocation params, small chain state", () => {
    const spans = replay("d1_langchain_chatopenai_tools");
    const lambda = byName("lc_lambda", spans);
    const llm = byName("ChatOpenAI", spans);
    assert.strictEqual(parentId(llm), lambda.spanContext().spanId);
    // Chain payloads only through smallState: none of its keys here.
    assert.strictEqual(lambda.attributes["lmnr.span.input"], undefined);
    assert.strictEqual(lambda.attributes["lmnr.span.output"], undefined);
    assert.strictEqual(
      lambda.attributes["lmnr.association.properties.session_id"],
      "lc-thread",
    );
    assert.deepStrictEqual(json(llm, "gen_ai.input.messages"), [
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.deepStrictEqual(json(llm, "gen_ai.output.messages"), [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_abc123",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
    ]);
    assert.strictEqual(
      (json(llm, "gen_ai.tool.definitions") as any[])[0].function.name,
      "get_weather",
    );
    assert.strictEqual(llm.attributes["gen_ai.request.model"], "gpt-4o-mini");
    assert.strictEqual(llm.attributes["gen_ai.response.model"], "gpt-4o-mini");
    assert.strictEqual(llm.attributes["gen_ai.response.id"], "chatcmpl-1");
    assert.strictEqual(llm.attributes["gen_ai.usage.total_tokens"], undefined);
    assert.strictEqual(llm.attributes["llm.usage.total_tokens"], 18);
  });

  void it("LangGraph: graph and node runs, state kept out", () => {
    const spans = replay("d2_langgraph_two_nodes");
    const graph = byName("LangGraph", spans);
    for (const node of ["inc", "dbl"]) {
      const span = byName(node, spans);
      assert.strictEqual(parentId(span), graph.spanContext().spanId, node);
      assert.strictEqual(span.attributes["lmnr.span.input"], undefined, node);
      // LangGraph's step tags are left out.
      assert.strictEqual(
        span.attributes["lmnr.association.properties.tags"],
        undefined,
        node,
      );
    }
    assert.strictEqual(graph.attributes["lmnr.span.output"], undefined);
    // `__start__` is tagged `langsmith:hidden`: no span, as in LangSmith's UI.
    assert.deepStrictEqual(spans.map((s) => s.name).sort(), [
      "LangGraph",
      "dbl",
      "inc",
    ]);
  });

  void it("an error becomes an exception event", () => {
    const [span] = replay("e_traceable_throws");
    assert.strictEqual(span.status.code, 2);
    const event = span.events.find((e) => e.name === "exception");
    assert.deepStrictEqual(event?.attributes, {
      "exception.type": "Error",
      "exception.message": "kaboom: y",
    });
  });

  void it("records a run once, from a complete create or an unseen update", () => {
    laminarExporter.reset();
    const recorder = new LangSmithRunRecorder();
    const [create, update] = fixtures.e_traceable_throws;
    const complete = {
      ...create.args.run,
      ...update.args.run,
      id: update.args.runId,
    };
    recorder.onCreate(structuredClone(complete), ROOT_CONTEXT, undefined);
    recorder.onUpdate(structuredClone(complete));
    assert.strictEqual(lmSpans().length, 1);
    assert.strictEqual(
      lmSpans()[0].attributes["lmnr.span.input"],
      '{"input":"y"}',
    );

    laminarExporter.reset();
    const fresh = new LangSmithRunRecorder();
    // The non-batched path only records updates whose create it saw.
    fresh.onUpdate(structuredClone(complete), undefined, true);
    assert.strictEqual(lmSpans().length, 0);
    fresh.onUpdate(structuredClone(complete));
    assert.strictEqual(lmSpans().length, 1);
  });

  void it("reparents children of glue runs", () => {
    laminarExporter.reset();
    const recorder = new LangSmithRunRecorder();
    const lc = { runtime: { library: "langchain-js" } };
    const run = (id: string, name: string, parent?: string) => ({
      id,
      name,
      run_type: "chain",
      trace_id: "00000000-0000-7000-8000-000000000001",
      parent_run_id: parent,
      start_time: "2026-01-01T00:00:00.000001Z",
      end_time: 1767225600001,
      extra: lc,
    });
    recorder.onCreate(
      run("00000000-0000-7000-8000-000000000001", "graph"),
      ROOT_CONTEXT,
      undefined,
    );
    recorder.onCreate(
      run(
        "00000000-0000-7000-8000-000000000002",
        "RunnableSequence",
        "00000000-0000-7000-8000-000000000001",
      ),
      ROOT_CONTEXT,
      undefined,
    );
    recorder.onCreate(
      run(
        "00000000-0000-7000-8000-000000000003",
        "node",
        "00000000-0000-7000-8000-000000000002",
      ),
      ROOT_CONTEXT,
      undefined,
    );
    const spans = lmSpans();
    assert.deepStrictEqual(spans.map((s) => s.name).sort(), ["graph", "node"]);
    assert.strictEqual(
      parentId(byName("node", spans)),
      byName("graph", spans).spanContext().spanId,
    );
    assert.deepStrictEqual(byName("node", spans).attributes["lmnr.span.path"], [
      "graph",
      "node",
    ]);
  });
});

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

const cjsRequire = createRequire(__filename);

void describe("LangSmith bridge (live)", () => {
  beforeEach(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
    laminarExporter.reset();
  });

  after(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
  });

  for (const autoBatchTracing of [true, false]) {
    void it(`leaves LangSmith's traffic unchanged (autoBatchTracing: ${autoBatchTracing})`, async () => {
      const without = langsmithClient({ autoBatchTracing });
      await traceableWorkload(without.client);
      await without.settle();

      initLaminar();
      const withBridge = langsmithClient({ autoBatchTracing });
      await traceableWorkload(withBridge.client);
      await withBridge.settle();
      await Laminar.flush();

      assert.ok(without.requests.length > 0);
      assert.deepStrictEqual(
        normalizeRequests(withBridge.requests),
        normalizeRequests(without.requests),
      );
      assert.deepStrictEqual(
        lmSpans()
          .map((s) => s.name)
          .sort(),
        ["boom", "fake_llm", "qa_chain"],
      );
      const chain = byName("qa_chain");
      assert.strictEqual(
        chain.attributes["lmnr.association.properties.metadata.tenant"],
        "acme",
      );
      assert.strictEqual(
        parentId(byName("fake_llm")),
        chain.spanContext().spanId,
      );
      assert.ok(byName("boom").events.some((e) => e.name === "exception"));
    });
  }

  void it("records runs that never ended as incomplete at shutdown", async () => {
    initLaminar();
    const { client, settle } = langsmithClient();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = { client, tracingEnabled: true };
    const lookup = traceable(async () => "found", {
      ...options,
      name: "lookup",
      run_type: "tool",
    });
    const stuck = traceable(() => blocked, {
      ...options,
      name: "stuck",
      run_type: "tool",
    });
    const agent = traceable(
      async (_question: string) => {
        await lookup();
        await stuck();
      },
      { ...options, name: "agent" },
    );
    const running = agent("plan a trip");
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepStrictEqual(
      lmSpans().map((s) => s.name),
      ["lookup"],
    );

    await Laminar.shutdown();
    const spans = lmSpans();
    assert.deepStrictEqual(
      spans.map((s) => s.name),
      ["lookup", "stuck", "agent"],
      "children end before their parents",
    );
    const incomplete = "langsmith.run.incomplete";
    assert.strictEqual(
      byName("lookup", spans).attributes[incomplete],
      undefined,
    );
    assert.strictEqual(byName("stuck", spans).attributes[incomplete], true);
    assert.strictEqual(byName("agent", spans).attributes[incomplete], true);
    const root = byName("agent", spans);
    assert.strictEqual(
      parentId(byName("stuck", spans)),
      root.spanContext().spanId,
    );
    assert.deepStrictEqual(
      byName("stuck", spans).attributes["lmnr.span.path"],
      ["agent", "stuck"],
    );
    assert.deepStrictEqual(json(root, "lmnr.span.input"), {
      input: "plan a trip",
    });
    assert.strictEqual(root.attributes["lmnr.span.output"], undefined);

    // The runs end after the bridge was uninstalled: nothing more is recorded.
    release();
    await running;
    await settle();
    assert.strictEqual(lmSpans().length, 3);
  });

  void it("nests a LangSmith trace under the Laminar span it started in", async () => {
    initLaminar();
    const { client, settle } = langsmithClient();
    await observe({ name: "outer", sessionId: "laminar-session" }, async () => {
      await traceableWorkload(client);
    });
    await settle();
    await Laminar.flush();
    const outer = byName("outer");
    const chain = byName("qa_chain");
    const llm = byName("fake_llm");
    assert.strictEqual(
      chain.spanContext().traceId,
      outer.spanContext().traceId,
    );
    assert.strictEqual(llm.spanContext().traceId, outer.spanContext().traceId);
    assert.strictEqual(parentId(chain), outer.spanContext().spanId);
    assert.deepStrictEqual(chain.attributes["lmnr.span.parent_path"], [
      "outer",
    ]);
    assert.deepStrictEqual(llm.attributes["lmnr.span.path"], [
      "outer",
      "qa_chain",
      "fake_llm",
    ]);
    const outerIds = outer.attributes["lmnr.span.ids_path"] as string[];
    assert.deepStrictEqual(
      (llm.attributes["lmnr.span.ids_path"] as string[]).slice(0, 1),
      outerIds,
    );
    // Laminar's context wins over the run's metadata.
    assert.strictEqual(
      chain.attributes["lmnr.association.properties.session_id"],
      "laminar-session",
    );
  });

  void it("records what LangSmith's redaction left", async () => {
    initLaminar();
    const { client, requests, settle } = langsmithClient({
      hideInputs: () => ({ redacted: true }),
    });
    await traceableWorkload(client);
    await settle();
    await Laminar.flush();
    assert.deepStrictEqual(json(byName("qa_chain"), "lmnr.span.input"), {
      redacted: true,
    });
    assert.ok(!JSON.stringify(requests).includes("Weather in Paris"));
    assert.ok(
      !lmSpans().some((s) =>
        JSON.stringify(s.attributes).includes("Weather in Paris"),
      ),
    );
  });

  void it("records nothing LangSmith sampled out", async () => {
    initLaminar();
    const { client, requests, settle } = langsmithClient({
      tracingSamplingRate: 0,
    });
    await traceableWorkload(client);
    await settle();
    await Laminar.flush();
    assert.deepStrictEqual(
      requests.filter((r) => r.path.includes("/runs")),
      [],
    );
    assert.deepStrictEqual(lmSpans(), []);
  });

  void it("records a run sent to several replicas once", async () => {
    initLaminar();
    const { client, requests, settle } = langsmithClient();
    const run = new RunTree({
      name: "replicated",
      client,
      tracingEnabled: true,
      replicas: [{ projectName: "replica-a" }, { projectName: "replica-b" }],
    });
    await run.postRun();
    const child = run.createChild({ name: "child" });
    await child.postRun();
    await child.end({ ok: true });
    await child.patchRun();
    await run.end({ done: true });
    await run.patchRun();
    await settle();
    await Laminar.flush();
    const creates = JSON.stringify(requests).match(/"post\.[^"]*?"/g) ?? [];
    assert.ok(creates.length >= 4, `LangSmith got ${creates.length} creates`);
    assert.deepStrictEqual(
      lmSpans()
        .map((s) => s.name)
        .sort(),
      ["child", "replicated"],
    );
    assert.strictEqual(
      parentId(byName("child")),
      byName("replicated").spanContext().spanId,
    );
  });

  void it("records a complete RunTree posted then patched once", async () => {
    initLaminar();
    const { client, settle } = langsmithClient();
    const run = new RunTree({
      name: "complete",
      client,
      tracingEnabled: true,
      inputs: { q: "hi" },
    });
    await run.end({ a: "yo" });
    await run.postRun();
    await run.patchRun();
    await settle();
    await Laminar.flush();
    assert.strictEqual(lmSpans().length, 1);
    const span = byName("complete");
    assert.deepStrictEqual(json(span, "lmnr.span.input"), { q: "hi" });
    assert.deepStrictEqual(json(span, "lmnr.span.output"), { a: "yo" });
  });

  void it("records a LangChain run under the Laminar span it started in", async () => {
    initLaminar();
    const { client, settle } = langsmithClient();
    const getWeather = tool(async ({ city }) => `sunny in ${city}`, {
      name: "get_weather",
      description: "Get the weather",
      schema: z.object({ city: z.string() }),
    });
    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      configuration: { fetch: mockLlmFetch as typeof fetch },
      maxRetries: 0,
    }).bindTools([getWeather]);
    const lambda = RunnableLambda.from(async (q: string) => {
      const message = await model.invoke(q);
      return message.tool_calls;
    }).withConfig({ runName: "lc_lambda", metadata: { thread_id: "t-1" } });
    const tracer = new LangChainTracer({ client });

    // LangChain runs tracer callbacks on a background queue; one that is
    // still busy runs the next run's callbacks in the async context of the
    // earlier call. Without the bridge's `BaseTracer` hook, "direct"'s chat
    // model run lands under "outer".
    await observe({ name: "outer" }, async () => {
      await lambda.invoke("Weather in Paris?", { callbacks: [tracer] });
    });
    await observe({ name: "direct" }, async () => {
      await model.invoke("Hi", { callbacks: [tracer] });
    });
    await settle();
    await Laminar.flush();

    const outer = byName("outer");
    const direct = byName("direct");
    const root = byName("lc_lambda");
    const [llm, directLlm] = ["lc_lambda", "direct"].map((parent) => {
      const span = lmSpans().find(
        (s) =>
          s.name === "ChatOpenAI" &&
          parentId(s) === byName(parent).spanContext().spanId,
      );
      assert.ok(span, `no ChatOpenAI span under ${parent}`);
      return span;
    });
    assert.strictEqual(root.spanContext().traceId, outer.spanContext().traceId);
    assert.strictEqual(parentId(root), outer.spanContext().spanId);
    assert.strictEqual(llm.spanContext().traceId, outer.spanContext().traceId);
    assert.strictEqual(
      directLlm.spanContext().traceId,
      direct.spanContext().traceId,
    );
    assert.deepStrictEqual(json(llm, "gen_ai.input.messages"), [
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.strictEqual(llm.attributes["llm.usage.total_tokens"], 18);
    assert.strictEqual(
      root.attributes["lmnr.association.properties.session_id"],
      "t-1",
    );
    // Laminar's LangChain instrumentation is off: no second LLM span.
    assert.strictEqual(
      lmSpans().filter((s) => s.attributes["lmnr.span.type"] === "LLM").length,
      2,
    );
  });

  void it("never breaks LangSmith when the bridge fails", async () => {
    initLaminar();
    const { client, requests, settle } = langsmithClient();
    const original = LangSmithRunRecorder.prototype.onCreate;
    LangSmithRunRecorder.prototype.onCreate = () => {
      throw new Error("bridge bug");
    };
    try {
      await traceableWorkload(client);
      await settle();
    } finally {
      LangSmithRunRecorder.prototype.onCreate = original;
    }
    const without = langsmithClient();
    await Laminar.shutdown();
    await traceableWorkload(without.client);
    await without.settle();
    assert.deepStrictEqual(
      normalizeRequests(requests),
      normalizeRequests(without.requests),
    );
  });

  void it("restores every patched method on shutdown", async () => {
    const targets = langsmithCopies().flatMap(({ client, runTree }) => [
      ...(client
        ? [
            "processRunOperation",
            "updateRun",
            // langsmith < 0.8 has no `_mergeRuntimeEnvAndMaskMetadata`.
            ...(typeof client._mergeRuntimeEnvAndMaskMetadata === "function"
              ? ["_mergeRuntimeEnvAndMaskMetadata"]
              : ["createRun", "prepareRunCreateOrUpdateInputs"]),
          ].map((name) => [client, name] as const)
        : []),
      ...(runTree
        ? ["postRun", "patchRun"].map((name) => [runTree, name] as const)
        : []),
    ]);
    const before = targets.map(([target, name]) => target[name]);
    initLaminar();
    assert.ok(targets.every(([target, name], i) => target[name] !== before[i]));
    await Laminar.shutdown();
    assert.ok(targets.every(([target, name], i) => target[name] === before[i]));
  });

  void it("patches the CommonJS and ESM copies of langsmith", () => {
    const copies = langsmithCopies();
    const manifestPath = cjsRequire.resolve("langsmith/package.json");
    const root = join(manifestPath, "..");
    const { exports } = JSON.parse(readFileSync(manifestPath, "utf8"));
    const esmFile = (subpath: string): string => {
      const entry = exports[subpath];
      const target =
        typeof entry === "string" ? entry : (entry.import ?? entry.default);
      return join(root, typeof target === "string" ? target : target.default);
    };
    const esmClient = cjsRequire(esmFile(".")).Client;
    const esmRunTree = cjsRequire(esmFile("./run_trees")).RunTree;
    assert.ok(copies.some((c) => c.client === Client.prototype));
    assert.ok(copies.some((c) => c.client === esmClient.prototype));
    assert.ok(copies.some((c) => c.runTree === RunTree.prototype));
    assert.ok(copies.some((c) => c.runTree === esmRunTree.prototype));
    assert.notStrictEqual(esmClient, Client);
  });

  void it("patches the copy an app's import gets (tsx)", async () => {
    // Under tsx, `import()` reaches a different copy than `require(esm)`.
    const imported = await import("langsmith");
    const prototype = imported.Client.prototype as Record<string, any>;
    const original = prototype.processRunOperation;
    const tap = new LangSmithTap(new LangSmithRunRecorder());
    assert.ok(tap.install());
    await tap.installImported();
    assert.notStrictEqual(prototype.processRunOperation, original);
    tap.uninstall();
    assert.strictEqual(prototype.processRunOperation, original);
  });

  void it("patches a copy when traceable first runs a run in it", () => {
    // Under tsx, `import()` lands a turn after `initialize()`; a `traceable`
    // called before then posts its run inside the shared storage's `run`.
    const storage = (globalThis as Record<symbol, any>)[
      Symbol.for("ls:tracing_async_local_storage")
    ];
    assert.ok(storage, "langsmith/traceable creates the shared storage");
    class AppClient {
      processRunOperation(_operation: Record<string, any>) {
        return Promise.resolve();
      }
    }
    class AppRunTree {
      readonly id = "00000000-0000-7000-8000-00000000000c";
      readonly client = new AppClient();
      postRun() {
        const run = {
          id: this.id,
          name: "app",
          inputs: { a: 1 },
          extra: { runtime: { sdk_version: "9.9.9" } },
        };
        return this.client.processRunOperation({ action: "create", item: run });
      }
    }
    const clientPrototype = AppClient.prototype as Record<string, any>;
    const original = clientPrototype.processRunOperation;
    const originalRun = storage.run;
    const recorder = new LangSmithRunRecorder();
    const creates: [Record<string, any>, string | undefined][] = [];
    recorder.onCreate = (run: Record<string, any>, _context, version) => {
      creates.push([run, version]);
    };
    const tap = new LangSmithTap(recorder);
    assert.ok(tap.install());
    try {
      const runTree = new AppRunTree();
      void storage.run(runTree, () => runTree.postRun());
      assert.notStrictEqual(clientPrototype.processRunOperation, original);
      assert.strictEqual(creates.length, 1);
      assert.deepStrictEqual(creates[0][0].inputs, { a: 1 });
      // The copy's version comes from the run's runtime info.
      assert.strictEqual(creates[0][1], "9.9.9");
    } finally {
      tap.uninstall();
    }
    assert.strictEqual(clientPrototype.processRunOperation, original);
    assert.strictEqual(storage.run, originalRun);
  });

  void it("reads unbatched creates on langsmith < 0.8", async () => {
    // langsmith < 0.8 has no `_mergeRuntimeEnvAndMaskMetadata`; `createRun`
    // prepares (samples, redacts) the run, then queues or POSTs it.
    const posted: Record<string, any>[] = [];
    class OldClient {
      constructor(readonly autoBatchTracing: boolean) {}
      async prepareRunCreateOrUpdateInputs(
        run: Record<string, any>,
      ): Promise<Record<string, any>> {
        return { ...run, inputs: { redacted: true } };
      }
      processRunOperation(operation: Record<string, any>) {
        operation.item = { ...operation.item };
        return Promise.resolve();
      }
      async createRun(run: Record<string, any>) {
        const runCreate = await this.prepareRunCreateOrUpdateInputs(run);
        if (this.autoBatchTracing) {
          void this.processRunOperation({ action: "create", item: runCreate });
          return;
        }
        runCreate.extra = { runtime: { sdk: "langsmith-js" } };
        await new Promise((resolve) => setTimeout(resolve, 5));
        posted.push(runCreate);
      }
    }
    const recorder = new LangSmithRunRecorder();
    const creates: Record<string, any>[] = [];
    recorder.onCreate = (run: Record<string, any>) => {
      creates.push(run);
    };
    const tap = new LangSmithTap(recorder);
    const prototype = OldClient.prototype as unknown as Record<string, any>;
    assert.ok(
      tap.install([
        { client: prototype, runTree: undefined, version: "0.7.17" },
      ]),
    );
    try {
      const run = {
        id: "00000000-0000-7000-8000-00000000000a",
        inputs: { a: 1 },
      };
      const sending = new OldClient(false).createRun(run);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // Recorded before the POST resolves, so children find it.
      assert.strictEqual(posted.length, 0);
      assert.strictEqual(creates.length, 1);
      assert.deepStrictEqual(creates[0].inputs, { redacted: true });
      assert.deepStrictEqual(creates[0].extra, {
        runtime: { sdk: "langsmith-js" },
      });
      await sending;

      await new OldClient(true).createRun({
        ...run,
        id: `${run.id.slice(0, -1)}b`,
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.strictEqual(
        creates.length,
        2,
        "a batched create is recorded once",
      );
    } finally {
      tap.uninstall();
    }
  });

  void it("does not mutate the run LangSmith queues", async () => {
    const tap = new LangSmithTap(new LangSmithRunRecorder());
    const prototype: Record<string, any> = {
      processRunOperation(operation: any) {
        operation.item = { ...operation.item, merged: true };
        return Promise.resolve();
      },
    };
    assert.ok(
      tap.install([{ client: prototype, runTree: undefined, version: "x" }]),
    );
    const item = {
      id: "00000000-0000-7000-8000-000000000009",
      name: "r",
      attachments: { file: ["image/png", new Uint8Array([1, 2])] },
      inputs: { q: 1 },
    };
    const operation = { action: "create", item };
    await prototype.processRunOperation(operation);
    assert.deepStrictEqual(operation.item, { ...item, merged: true });
    assert.ok(operation.item.attachments.file[1] instanceof Uint8Array);
    await prototype.processRunOperation({ action: "feedback", item: {} });
    tap.uninstall();
  });
});

void describe("LangSmith bridge process exit", () => {
  // `exit-child.ts`: an agent whose `stuck` tool never ends, then an exit.
  const runChild = (
    mode: string,
    signal?: NodeJS.Signals,
  ): Promise<{ lines: string[]; code: number | null; signal: string | null }> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          join(__dirname, "langsmith-bridge/exit-child.ts"),
          mode,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let output = "";
      let signaled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        // Once: a second Ctrl-C exits at once, before the export.
        if (signal && !signaled && output.includes("ready\n")) {
          signaled = true;
          child.kill(signal);
        }
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("error", reject);
      child.on("close", (code, exitSignal) => {
        clearTimeout(timer);
        resolve({
          lines: output.split("\n").filter((l) => l.startsWith("exported")),
          code,
          signal: exitSignal,
        });
      });
    });

  const expected = [
    "exported lookup false",
    "exported stuck true",
    "exported agent true",
  ];

  void it("records open runs when the event loop empties", async () => {
    const { lines, code } = await runChild("beforeExit");
    assert.deepStrictEqual(lines, expected);
    // An unsettled top-level promise isn't an error here (not top-level await).
    assert.strictEqual(code, 0);
  });

  void it("records open runs on SIGINT, then exits by the signal", async () => {
    const result = await runChild("signal", "SIGINT");
    assert.deepStrictEqual(result.lines, expected);
    assert.strictEqual(result.signal, "SIGINT");
  });

  void it("exports on SIGINT while a stream is still being read", async () => {
    // `Laminar.flush()` first waits up to 5 s for pending streams, longer than
    // the 3 s cap, so the exit flushes the span processor directly.
    const result = await runChild("signal-stream", "SIGINT");
    assert.deepStrictEqual(result.lines, expected);
    assert.strictEqual(result.signal, "SIGINT");
  });

  void it("leaves SIGINT to the app's own handler", async () => {
    // The app's handler calls `Laminar.shutdown()`, which ends the open runs.
    const result = await runChild("signal-handled", "SIGINT");
    assert.deepStrictEqual(result.lines, expected);
    assert.strictEqual(result.code, 7);
  });
});

void describe("LangSmith bridge initialize", () => {
  after(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
  });

  void it("disables the conflicting instrumentations and leaves the global context alone", async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
    initLaminar();
    const conflicts = new LangSmithBridge().conflictingInstrumentations;
    assert.deepStrictEqual(_configuration?.disabledInstrumentations, conflicts);
    assert.ok(conflicts.includes("langchain"));
    assert.ok(conflicts.includes("claudeAgentSDK"));
    assert.ok(!conflicts.includes("piDurable"));
    assert.strictEqual(
      (LaminarContextManager as any)._inheritGlobalContext,
      false,
    );
    await Laminar.shutdown();

    initLaminar({ instrumentModules: {} });
    assert.strictEqual(_configuration?.disabledInstrumentations, undefined);
    await Laminar.shutdown();
  });
});
