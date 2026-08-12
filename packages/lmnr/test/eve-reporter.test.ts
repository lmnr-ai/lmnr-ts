import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type StringUUID } from "@lmnr-ai/types";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import {
  type EveClientSessionClass,
  type EveEval,
  type EveEvalResult,
  type EveEvalTarget,
  LaminarReporter,
  patchEveClientSession,
} from "../src/integrations/eve";
import { Laminar } from "../src/laminar";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib";
import { LaminarContextManager } from "../src/opentelemetry-lib/tracing/context";
import { otelSpanIdToUUID, otelTraceIdToUUID } from "../src/utils";

type RequestBody = Record<string, any>;

// `RequestBody` is intentionally loose, so narrow the scores map at the read
// site rather than sprinkling casts through the assertions.
const scoresOf = (body: RequestBody): Record<string, number> =>
  body.scores as Record<string, number>;

const NOCK_URL = "https://api.lmnr.ai:443";
const PROJECT_API_KEY = "test-api-key";
const MOCK_EVAL_ID: StringUUID = "12345678-1234-1234-1234-123456789abc";

const DATAPOINT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mockInit = (capture?: (body: RequestBody) => void) =>
  nock(NOCK_URL)
    .post("/v1/evals", (body: RequestBody) => {
      capture?.(body);
      return true;
    })
    .reply(200, {
      id: MOCK_EVAL_ID,
      createdAt: new Date().toISOString(),
      groupId: "group-123",
      name: "eve-run",
      projectId: "project-123",
    });

void describe("LaminarReporter for eve evals", () => {
  let exporter: InMemorySpanExporter;

  const makeReporter = () =>
    new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

  void beforeEach(() => {
    process.env.LMNR_PROJECT_API_KEY = PROJECT_API_KEY;
    exporter = new InMemorySpanExporter();
  });

  void afterEach(() => {
    nock.cleanAll();
  });

  void it("creates one Laminar evaluation on run start with eve metadata", async () => {
    let body: RequestBody = {};
    const scope = mockInit((b) => (body = b));

    const reporter = makeReporter();
    const evals: EveEval[] = [{ id: "a" }, { id: "b" }];
    const target: EveEvalTarget = { kind: "local", url: "http://localhost:1234" };
    await reporter.onRunStart(evals, target);

    assert.strictEqual(body.name, "eve-run");
    assert.strictEqual(body.metadata.source, "eve");
    assert.strictEqual(body.metadata.targetKind, "local");
    assert.strictEqual(body.metadata.targetUrl, "http://localhost:1234");
    assert.strictEqual(body.metadata.evalCount, 2);
    scope.done();
  });

  void it("keeps eve run facts when user metadata collides", async () => {
    let body: RequestBody = {};
    const scope = mockInit((b) => (body = b));

    const reporter = new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(exporter),
      metadata: { source: "custom", evalCount: 999, suite: "smoke" },
    });
    await reporter.onRunStart([{ id: "a" }], { kind: "local" });

    assert.strictEqual(body.metadata.source, "eve");
    assert.strictEqual(body.metadata.evalCount, 1);
    assert.strictEqual(body.metadata.suite, "smoke");
    scope.done();
  });

  void it("reports a graded eval onto the reporter-owned trace", async () => {
    const initScope = mockInit();

    let createBody: RequestBody = {};
    const createScope = nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});

    let updateBody: RequestBody = {};
    const updateScope = nock(NOCK_URL)
      .post(
        new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/${DATAPOINT_ID_RE.source.slice(1, -1)}`),
        (b: RequestBody) => {
          updateBody = b;
          return true;
        },
      )
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([
      {
        id: "brooklyn-forecast",
        description: "Checks that the agent can answer with local weather.",
      },
    ], { kind: "local" });

    const result: EveEvalResult = {
      id: "brooklyn-forecast",
      verdict: "passed",
      result: {
        output: "It is sunny.",
        finalMessage: "It is sunny.",
        sessionId: "wrun_abc123",
        status: "completed",
        derived: {
          toolCalls: [{ name: "get_weather" }],
          toolCallCount: 1,
        },
        runtimeIdentity: { modelId: "gpt-4o-mini" },
      },
      assertions: [
        { name: "relevance", score: 0.9, severity: "soft", passed: true },
        { name: "no-refusal", score: 1, severity: "gate", passed: true },
      ],
    };
    await reporter.onEvalComplete(result);

    // No session trace was propagated, so the reporter owns an EVALUATION span
    // and the datapoint links to ITS trace. No lookup query is ever issued —
    // nock would throw on an unmocked request if one were.
    const reporterSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "eve eval brooklyn-forecast");
    assert.ok(reporterSpan, "expected a reporter-owned EVALUATION span");

    // create datapoint
    assert.strictEqual(createBody.points.length, 1);
    const point = createBody.points[0];
    assert.ok(DATAPOINT_ID_RE.test(point.id));
    assert.strictEqual(
      point.traceId,
      otelTraceIdToUUID(reporterSpan.spanContext().traceId),
    );
    assert.strictEqual(point.data, "brooklyn-forecast");
    assert.strictEqual(point.target, "It is sunny.");
    assert.strictEqual(point.index, 0);
    assert.strictEqual(point.metadata.name, "brooklyn-forecast");
    assert.strictEqual(point.metadata.verdict, "passed");
    assert.strictEqual(point.metadata.status, "completed");
    assert.strictEqual(
      point.metadata.description,
      "Checks that the agent can answer with local weather.",
    );
    assert.strictEqual(point.metadata.sessionId, "wrun_abc123");
    assert.deepStrictEqual(point.metadata.toolCalls, ["get_weather"]);
    assert.strictEqual(point.metadata.modelId, "gpt-4o-mini");
    assert.strictEqual(point.metadata.traceResolution, "reporter-fallback");

    assert.deepStrictEqual(updateBody.scores, {
      "eve.verdict.passed": 1,
      "eve.gates.passed": 1,
      "eve.soft_thresholds.passed": 1,
    });
    assert.strictEqual(updateBody.executorOutput, "It is sunny.");
    assert.deepStrictEqual(point.metadata.assertions, [
      {
        name: "relevance",
        score: 0.9,
        severity: "soft",
        passed: true,
      },
      {
        name: "no-refusal",
        score: 1,
        severity: "gate",
        passed: true,
      },
    ]);

    // Both the trace and the span type, exactly as the propagated root stamps
    // them — without the trace type the datapoint's trace loses its evaluation
    // association.
    assert.strictEqual(reporterSpan.attributes["lmnr.span.type"], "EVALUATION");
    assert.strictEqual(
      reporterSpan.attributes["lmnr.association.properties.trace_type"],
      "EVALUATION",
    );

    // Eval metadata rides on the span, never on a `/v1/traces/metadata` POST.
    const meta = "lmnr.association.properties.metadata";
    assert.strictEqual(reporterSpan.attributes[`${meta}.source`], "eve");
    assert.strictEqual(
      reporterSpan.attributes[`${meta}.eveEvalId`],
      "brooklyn-forecast",
    );
    assert.strictEqual(
      reporterSpan.attributes[`${meta}.eveEvalDescription`],
      "Checks that the agent can answer with local weather.",
    );
    assert.strictEqual(reporterSpan.attributes[`${meta}.eveEvalVerdict`], "passed");
    assert.strictEqual(reporterSpan.attributes[`${meta}.eveSessionId`], "wrun_abc123");

    initScope.done();
    createScope.done();
    updateScope.done();
  });

  void it("encodes a failed gate in both the scores and the metadata", async () => {
    mockInit();
    let createBody: RequestBody = {};
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});
    let updateBody: RequestBody = {};
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`), (b: RequestBody) => {
        updateBody = b;
        return true;
      })
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "failed",
      result: { status: "completed" },
      assertions: [
        {
          name: "must-answer",
          score: 0,
          severity: "gate",
          passed: false,
          message: "no answer produced",
        },
      ],
    });

    assert.deepStrictEqual(updateBody.scores, {
      "eve.verdict.passed": 0,
      "eve.gates.passed": 0,
      "eve.soft_thresholds.passed": 1,
    });
    assert.deepStrictEqual(createBody.points[0].metadata.failedAssertions, [
      { name: "must-answer", message: "no answer produced" },
    ]);
  });

  void it("treats a zero-score gate without a passed flag as failed", async () => {
    mockInit();
    let createBody: RequestBody = {};
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});
    let updateBody: RequestBody = {};
    nock(NOCK_URL)
      .post(
        new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`),
        (b: RequestBody) => {
          updateBody = b;
          return true;
        },
      )
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    // Degraded eve shape: no `passed` flag on the assertion.
    await reporter.onEvalComplete({
      id: "a",
      verdict: "failed",
      result: { status: "completed" },
      assertions: [
        { name: "must-answer", score: 0, severity: "gate", message: "no answer" },
      ],
    });

    assert.strictEqual(updateBody.scores["eve.gates.passed"], 0);
    assert.deepStrictEqual(createBody.points[0].metadata.failedAssertions, [
      { name: "must-answer", message: "no answer" },
    ]);
  });

  void it("uses the same score keys for heterogeneous evals, indexed in order", async () => {
    mockInit();
    const indices: number[] = [];
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        indices.push(b.points[0].index);
        return true;
      })
      .twice()
      .reply(200, {});
    const scoreUpdates: RequestBody[] = [];
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`), (b: RequestBody) => {
        scoreUpdates.push(b);
        return true;
      })
      .twice()
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }, { id: "b" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { status: "completed", finalMessage: "hello" },
      assertions: [
        { name: "includes(/hello/)", score: 1, severity: "gate", passed: true },
      ],
    });
    await reporter.onEvalComplete({
      id: "b",
      verdict: "passed",
      result: { status: "completed", finalMessage: "weather" },
      assertions: [
        { name: "calledTool(web_fetch)", score: 1, severity: "gate", passed: true },
      ],
    });

    // Different eval files assert different things, but the score COLUMNS must
    // match or Laminar's eval UI reads the sparse cells as incomplete. Exact
    // score values are pinned by the graded-eval and failed-gate cases above.
    const KEYS = [
      "eve.gates.passed",
      "eve.soft_thresholds.passed",
      "eve.verdict.passed",
    ];
    assert.deepStrictEqual(
      scoreUpdates.map((body) => Object.keys(scoresOf(body)).sort()),
      [KEYS, KEYS],
    );
    assert.deepStrictEqual(indices, [0, 1]);
  });

  void it("does not throw when onRunStart failed and onEvalComplete runs", async () => {
    nock(NOCK_URL).post("/v1/evals").reply(500, "boom");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    // No eval/datapoint endpoint mocked — if the reporter tried to call it,
    // nock would throw on an unmocked request. It must short-circuit instead.
    await assert.doesNotReject(() => reporter.onEvalComplete({ id: "a" }));
    assert.doesNotThrow(() => reporter.onRunComplete());
  });

  void it("mints no session traces after onRunStart failed", async () => {
    nock(NOCK_URL).post("/v1/evals").reply(500, "boom");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});

    // The patch stays installed, but with no evaluation to attach results to it
    // must stop minting traces — every span it opened would be an orphan the
    // datapoint never links to.
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const session = new SessionClass("wrun_orphan");
    await session.send("hello");

    assert.strictEqual(session.sentInputs[0], "hello");
    await reporter.onRunComplete();
    assert.deepStrictEqual(exporter.getFinishedSpans(), []);
  });

  void it("swallows datapoint errors so a bad eval never breaks the run", async () => {
    mockInit();
    nock(NOCK_URL).post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`).reply(500, "nope");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await assert.doesNotReject(() =>
      reporter.onEvalComplete({ id: "a", result: {}, assertions: [] }),
    );
  });

  void it("flushes the host pipeline on run complete", async () => {
    mockInit();
    // Judge spans go to the host's own Laminar pipeline, and eve calls
    // `process.exit()` right after this hook — so this is their only flush point.
    const originalFlush = Laminar.flush.bind(Laminar);
    let flushes = 0;
    Laminar.flush = () => {
      flushes += 1;
      return Promise.resolve();
    };
    try {
      const reporter = makeReporter();
      await reporter.onRunStart([{ id: "a" }], {});
      await reporter.onRunComplete();
      assert.strictEqual(flushes, 1);
    } finally {
      Laminar.flush = originalFlush;
    }
  });
});

/**
 * Stand-in for eve's `ClientSession`. `send` sits on the prototype and returns a
 * `MessageResponse`-shaped object, which is all the patch touches — so the suite
 * needs no dependency on eve. Each test builds a FRESH subclass so the
 * double-patch WeakSet in the reporter module cannot leak across tests.
 */
const makeStubSessionClass = (): {
  new(eveSessionId: string): {
    eveSessionId: string;
    sentInputs: unknown[];
    send(input: unknown): Promise<{ sessionId: string }>;
  };
} =>
  class StubEveClientSession {
    public sentInputs: unknown[] = [];
    constructor(public eveSessionId: string) {}
    async send(input: unknown): Promise<{ sessionId: string }> {
      this.sentInputs.push(input);
      return Promise.resolve({ sessionId: this.eveSessionId });
    }
  };

const parseTraceparent = (headers: Record<string, string>) => {
  const parts = (headers.traceparent ?? "").split("-");
  return { traceIdHex: parts[1], spanIdHex: parts[2], flags: parts[3] };
};

const headersOf = (input: unknown): Record<string, string> =>
  (input as { headers?: Record<string, string> }).headers ?? {};

void describe("LaminarReporter eve trace propagation", () => {
  let exporter: InMemorySpanExporter;

  const makeReporter = (options: Record<string, any> = {}) =>
    new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(exporter),
      ...options,
    });

  const mockDatapointWrites = (capture?: (body: RequestBody) => void) => {
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        capture?.(b);
        return true;
      })
      .times(4)
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
      .times(4)
      .reply(200, {});
  };

  void beforeEach(() => {
    process.env.LMNR_PROJECT_API_KEY = PROJECT_API_KEY;
    exporter = new InMemorySpanExporter();
  });

  void afterEach(() => {
    nock.cleanAll();
  });

  void it("pushes a runner-minted traceparent into every eve send", async () => {
    mockInit();
    mockDatapointWrites();

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], { kind: "local" });
    const SessionClass = makeStubSessionClass();
    assert.strictEqual(
      patchEveClientSession(SessionClass as unknown as EveClientSessionClass),
      true,
    );

    const session = new SessionClass("wrun_1");
    const response = await session.send("hello");
    assert.strictEqual(response.sessionId, "wrun_1");

    // A bare string input is normalized to `{ message }` exactly as eve does.
    assert.strictEqual(
      (session.sentInputs[0] as { message?: string }).message,
      "hello",
    );
    const headers = headersOf(session.sentInputs[0]);
    const { traceIdHex, spanIdHex, flags } = parseTraceparent(headers);
    assert.match(traceIdHex, /^[0-9a-f]{32}$/);
    assert.match(spanIdHex, /^[0-9a-f]{16}$/);
    assert.strictEqual(flags, "01");
    const laminarContext = JSON.parse(headers["x-lmnr-span-context"]);
    assert.strictEqual(laminarContext.traceId, otelTraceIdToUUID(traceIdHex));
    assert.strictEqual(laminarContext.isRemote, true);
    // The path must travel with the ids. Laminar nests by `lmnr.span.ids_path`,
    // so a receiver that adopts only the ids lands as a second root instead of
    // under the executor. Both names are constant, so the path is exact.
    assert.strictEqual(laminarContext.spanId, otelSpanIdToUUID(spanIdHex));
    assert.deepStrictEqual(laminarContext.spanPath, ["eve eval", "executor"]);
    assert.strictEqual(laminarContext.spanIdsPath.length, 2);
    assert.strictEqual(laminarContext.spanIdsPath[1], laminarContext.spanId);

    // A second turn on the same eve session reuses the same trace.
    await session.send({ message: "again", headers: { "x-user": "kolbe" } });
    const secondHeaders = headersOf(session.sentInputs[1]);
    assert.strictEqual(secondHeaders.traceparent, headers.traceparent);
    assert.strictEqual(secondHeaders["x-user"], "kolbe");

    await reporter.onRunComplete();
  });

  void it("resolves the datapoint trace from the propagated session", async () => {
    mockInit();
    let createBody: RequestBody = {};
    mockDatapointWrites((b) => (createBody = b));

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a", description: "checks a thing" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const session = new SessionClass("wrun_1");
    await session.send("hello");
    const { traceIdHex } = parseTraceparent(headersOf(session.sentInputs[0]));

    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_1", status: "waiting", finalMessage: "hi" },
      assertions: [
        { name: "includes(/hi/)", score: 1, severity: "gate", passed: true },
        { name: "similarity", score: 0.8, severity: "soft" },
      ],
    });

    const point = createBody.points[0];
    assert.strictEqual(point.traceId, otelTraceIdToUUID(traceIdHex));
    assert.strictEqual(point.metadata.traceResolution, "propagated");

    const spans = exporter.getFinishedSpans();
    // The root keeps the name it was minted with — eve cannot tell us the eval
    // id before the first send, so the id rides on attributes, not the name.
    const root = spans.find((span) => span.name === "eve eval");
    const executor = spans.find((span) => span.name === "executor");
    assert.ok(root, "expected an EVALUATION root span");
    assert.ok(executor, "expected an EXECUTOR span");
    assert.strictEqual(root.attributes["lmnr.span.type"], "EVALUATION");
    assert.strictEqual(
      root.attributes["lmnr.association.properties.trace_type"],
      "EVALUATION",
    );
    assert.strictEqual(root.attributes["lmnr.eve.eval.id"], "a");
    assert.strictEqual(executor.attributes["lmnr.span.type"], "EXECUTOR");
    // The trace type rides on every span the reporter owns, matching what the
    // native evaluator's association properties stamp on each descendant.
    assert.strictEqual(
      executor.attributes["lmnr.association.properties.trace_type"],
      "EVALUATION",
    );
    // The agent's turn is parented to the executor span, not the root.
    assert.strictEqual(
      parseTraceparent(headersOf(session.sentInputs[0])).spanIdHex,
      executor.spanContext().spanId,
    );

    const evaluators = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATOR",
    );
    assert.deepStrictEqual(
      evaluators.map((span) => span.name).sort(),
      ["includes(/hi/)", "similarity"],
    );
    // No explicit parent path is declared any more — see the span-path test
    // below, which runs a real LaminarSpanProcessor and checks the tree.
    assert.strictEqual(
      evaluators[0].attributes["lmnr.span.parent_path"],
      undefined,
    );
    assert.ok(evaluators.every(
      (span) => span.spanContext().traceId === root.spanContext().traceId,
    ));
    assert.ok(evaluators.every(
      (span) =>
        span.attributes["lmnr.association.properties.trace_type"] ===
          "EVALUATION",
    ));

    await reporter.onRunComplete();
  });

  void it("builds the span path tree without rewriting any path", async () => {
    mockInit();
    mockDatapointWrites();

    // The real processor, not the SimpleSpanProcessor the other cases inject:
    // `lmnr.span.path` is stamped in its `onStart`, and the whole point of
    // keeping the root's name stable is that those stamps stay correct.
    const reporter = new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new LaminarSpanProcessor({ exporter, disableBatch: true }),
    });
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    await new SessionClass("wrun_1").send("hello");

    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_1", status: "waiting", finalMessage: "hi" },
      assertions: [{ name: "judge.autoevals.closedQA", score: 1, severity: "soft" }],
    });

    const pathOf = (name: string) =>
      exporter.getFinishedSpans()
        .find((span) => span.name === name)
        ?.attributes["lmnr.span.path"];
    assert.deepStrictEqual(pathOf("eve eval"), ["eve eval"]);
    assert.deepStrictEqual(pathOf("executor"), ["eve eval", "executor"]);
    // Inherited from the processor's cache for the root — nothing declares it.
    assert.deepStrictEqual(pathOf("judge.autoevals.closedQA"), [
      "eve eval",
      "judge.autoevals.closedQA",
    ]);

    await reporter.onRunComplete();
  });

  void it("binds the eval's async context to the root, not to one judge span", async () => {
    mockInit();
    mockDatapointWrites();

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const session = new SessionClass("wrun_1");
    await session.send("hello");

    // What `t.judge.autoevals.*` sees: eve runs the judge's model call in the
    // runner, and Laminar's AI SDK integration parents it to whatever this
    // resolves to. Every judge in the eval reads the SAME context, so the bound
    // span must be the root — a per-judge parent would collect judge B's model
    // call under judge A.
    const boundSpan = trace.getSpan(LaminarContextManager.getContext());
    assert.ok(boundSpan, "expected the eval's async context to carry a span");
    const boundSpanId = boundSpan.spanContext().spanId;

    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_1", status: "waiting", finalMessage: "hi" },
      assertions: [
        { name: "judge.autoevals.closedQA", score: 1, severity: "soft" },
        { name: "judge.autoevals.factuality", score: 0.9, severity: "soft" },
      ],
    });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "eve eval");
    const executor = spans.find((span) => span.name === "executor");
    assert.ok(root);
    assert.ok(executor);
    assert.strictEqual(boundSpanId, root.spanContext().spanId);
    assert.notStrictEqual(boundSpanId, executor.spanContext().spanId);

    // Two judges in one eval each get their own EVALUATOR span. Nothing is
    // pre-opened and nothing is claimed, so neither judge can crowd out the other.
    const evaluators = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATOR",
    );
    assert.deepStrictEqual(
      evaluators.map((span) => span.name).sort(),
      ["judge.autoevals.closedQA", "judge.autoevals.factuality"],
    );

    await reporter.onRunComplete();
  });

  void it("keeps concurrent evals on separate traces", async () => {
    mockInit();
    const createBodies: RequestBody[] = [];
    mockDatapointWrites((b) => createBodies.push(b));

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }, { id: "b" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);

    // Two evals in flight at once, as with the default maxConcurrency of 8.
    const first = new SessionClass("wrun_a");
    const second = new SessionClass("wrun_b");
    await Promise.all([first.send("one"), second.send("two")]);

    const firstTrace = parseTraceparent(headersOf(first.sentInputs[0]));
    const secondTrace = parseTraceparent(headersOf(second.sentInputs[0]));
    assert.notStrictEqual(firstTrace.traceIdHex, secondTrace.traceIdHex);

    // Grade in the opposite order to the sends — attribution must follow the
    // session id, not arrival order.
    await reporter.onEvalComplete({
      id: "b",
      verdict: "passed",
      result: { sessionId: "wrun_b", status: "waiting" },
      assertions: [],
    });
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_a", status: "waiting" },
      assertions: [],
    });

    const byName = new Map(
      createBodies.map((body) => [
        body.points[0].metadata.name as string,
        body.points[0] as RequestBody,
      ]),
    );
    assert.strictEqual(
      byName.get("a")?.traceId,
      otelTraceIdToUUID(firstTrace.traceIdHex),
    );
    assert.strictEqual(
      byName.get("b")?.traceId,
      otelTraceIdToUUID(secondTrace.traceIdHex),
    );
    assert.strictEqual(byName.get("a")?.metadata.traceResolution, "propagated");
    assert.strictEqual(byName.get("b")?.metadata.traceResolution, "propagated");

    // Both roots share one name; the eval id is what tells them apart, and each
    // sits on its own trace.
    const roots = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["lmnr.span.type"] === "EVALUATION");
    assert.deepStrictEqual(
      roots.map((span) => span.name),
      ["eve eval", "eve eval"],
    );
    assert.deepStrictEqual(
      roots.map((span) => span.attributes["lmnr.eve.eval.id"]).sort(),
      ["a", "b"],
    );
    assert.strictEqual(
      new Set(roots.map((span) => span.spanContext().traceId)).size,
      2,
    );

    await reporter.onRunComplete();
  });

  void it("wraps send only once per prototype", async () => {
    mockInit();
    mockDatapointWrites();

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const patched = SessionClass.prototype.send;
    assert.strictEqual(
      patchEveClientSession(SessionClass as unknown as EveClientSessionClass),
      true,
    );
    assert.strictEqual(SessionClass.prototype.send, patched);

    const session = new SessionClass("wrun_1");
    await session.send("hello");
    // A double wrap would have normalized the payload twice, nesting headers.
    assert.strictEqual(session.sentInputs.length, 1);
    assert.match(headersOf(session.sentInputs[0]).traceparent, /^00-/);

    await reporter.onRunComplete();
  });

  void it("leaves eve's payload alone when propagation is disabled", async () => {
    mockInit();
    let createBody: RequestBody = {};
    mockDatapointWrites((b) => (createBody = b));

    const reporter = makeReporter({ propagateTraceContext: false });
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const session = new SessionClass("wrun_1");
    await session.send("hello");

    // The patch is installed but no factory is registered, so eve's payload is
    // untouched and no trace is minted for the session.
    assert.strictEqual(session.sentInputs[0], "hello");
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_1", status: "waiting" },
      assertions: [],
    });

    assert.strictEqual(
      createBody.points[0].metadata.traceResolution,
      "reporter-fallback",
    );

    await reporter.onRunComplete();
  });

  void it("falls back when the graded session id was never propagated", async () => {
    mockInit();
    let createBody: RequestBody = {};
    mockDatapointWrites((b) => (createBody = b));

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    // No send at all — e.g. eve talked to the agent through a path the patch
    // does not cover, or eve was absent so the patch never installed.
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_unknown", status: "waiting" },
      assertions: [],
    });

    const fallback = exporter
      .getFinishedSpans()
      .find((span) => span.name === "eve eval a");
    assert.ok(fallback, "expected a reporter-owned EVALUATION span");
    assert.strictEqual(
      createBody.points[0].traceId,
      otelTraceIdToUUID(fallback.spanContext().traceId),
    );
    assert.strictEqual(
      createBody.points[0].metadata.traceResolution,
      "reporter-fallback",
    );

    await reporter.onRunComplete();
  });

  void it("closes session spans that never reached onEvalComplete", async () => {
    mockInit();
    mockDatapointWrites();

    // InMemorySpanExporter wipes itself on shutdown, and the spans under test
    // are only exported during onRunComplete — keep them past the shutdown.
    exporter = new (class extends InMemorySpanExporter {
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    })();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    await new SessionClass("wrun_orphan").send("hello");

    assert.deepStrictEqual(exporter.getFinishedSpans(), []);
    await reporter.onRunComplete();

    const names = exporter.getFinishedSpans().map((span) => span.name).sort();
    assert.deepStrictEqual(names, ["eve eval", "executor"]);
  });
});
