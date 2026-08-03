import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type StringUUID } from "@lmnr-ai/types";
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
import { otelTraceIdToUUID } from "../src/utils";

type RequestBody = Record<string, any>;

const NOCK_URL = "https://api.lmnr.ai:443";
const PROJECT_API_KEY = "test-api-key";
const MOCK_EVAL_ID: StringUUID = "12345678-1234-1234-1234-123456789abc";
const EVE_AGENT_TRACE_ID: StringUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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

const mockTraceLookup = (
  rows: Array<Record<string, any>>,
  capture?: (body: RequestBody) => void,
) =>
  nock(NOCK_URL)
    .post("/v1/sql/query", (body: RequestBody) => {
      capture?.(body);
      return true;
    })
    .reply(200, { data: rows });

const mockTraceMetadata = (capture?: (body: RequestBody) => void) =>
  nock(NOCK_URL)
    .post("/v1/traces/metadata", (body: RequestBody) => {
      capture?.(body);
      return true;
    })
    .reply(200, {});

void describe("LaminarReporter for eve evals", () => {
  let exporter: InMemorySpanExporter;

  const makeReporter = () =>
    new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(exporter),
      traceLookupAttempts: 1,
      traceLookupDelayMs: 0,
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

  void it("reports a graded eval and links it to the matching eve agent trace", async () => {
    const initScope = mockInit();
    let sqlBody: RequestBody = {};
    const sqlScope = mockTraceLookup(
      [{ trace_id: EVE_AGENT_TRACE_ID, span_count: 12 }],
      (b) => (sqlBody = b),
    );
    let traceMetadataBody: RequestBody = {};
    const traceMetadataScope = mockTraceMetadata((b) => (traceMetadataBody = b));

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

    assert.match(sqlBody.query, /workflow\.run\.id/);
    assert.match(sqlBody.query, /span_type != 'EVALUATION'/);
    assert.deepStrictEqual(sqlBody.parameters, { session_id: "wrun_abc123" });

    // create datapoint
    assert.strictEqual(createBody.points.length, 1);
    const point = createBody.points[0];
    assert.ok(DATAPOINT_ID_RE.test(point.id));
    assert.strictEqual(point.traceId, EVE_AGENT_TRACE_ID);
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
    assert.strictEqual(point.metadata.traceResolution, "eve-session");
    assert.strictEqual(point.metadata.traceResolutionAttempt, 1);
    assert.deepStrictEqual(exporter.getFinishedSpans(), []);

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

    assert.strictEqual(traceMetadataBody.traceId, EVE_AGENT_TRACE_ID);
    assert.strictEqual(traceMetadataBody.metadata.source, "eve");
    assert.strictEqual(traceMetadataBody.metadata.eveEvalId, "brooklyn-forecast");
    assert.strictEqual(
      traceMetadataBody.metadata.eveEvalDescription,
      "Checks that the agent can answer with local weather.",
    );
    assert.strictEqual(traceMetadataBody.metadata.eveEvalVerdict, "passed");
    assert.strictEqual(traceMetadataBody.metadata.eveSessionId, "wrun_abc123");

    initScope.done();
    sqlScope.done();
    createScope.done();
    updateScope.done();
    traceMetadataScope.done();
  });

  void it("retries eve trace lookup before creating the datapoint", async () => {
    mockInit();
    mockTraceLookup([]);
    const secondLookupScope = mockTraceLookup([
      { trace_id: EVE_AGENT_TRACE_ID, span_count: 3 },
    ]);
    let createBody: RequestBody = {};
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
      .reply(200, {});

    const reporter = new LaminarReporter({
      name: "eve-run",
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(exporter),
      traceLookupAttempts: 2,
      traceLookupDelayMs: 0,
    });
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_retry", status: "completed" },
      assertions: [],
    });

    assert.strictEqual(createBody.points[0].traceId, EVE_AGENT_TRACE_ID);
    assert.strictEqual(createBody.points[0].metadata.traceResolutionAttempt, 2);
    secondLookupScope.done();
  });

  void it("falls back to a reporter trace when no eve agent trace is found", async () => {
    mockInit();
    const sqlScope = mockTraceLookup([]);
    let createBody: RequestBody = {};
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "failed",
      result: { sessionId: "wrun_missing", status: "failed" },
      assertions: [],
    });

    const reporterSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "eve eval a");
    assert.ok(reporterSpan, "expected a fallback reporter trace span");
    assert.strictEqual(
      createBody.points[0].traceId,
      otelTraceIdToUUID(reporterSpan.spanContext().traceId),
    );
    assert.strictEqual(
      createBody.points[0].metadata.traceResolution,
      "reporter-fallback",
    );
    sqlScope.done();
  });

  void it("encodes a failed gate in stable summary scores", async () => {
    mockInit();
    nock(NOCK_URL).post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`).reply(200, {});
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
        { name: "must-answer", score: 0, severity: "gate", passed: false },
      ],
    });

    assert.deepStrictEqual(updateBody.scores, {
      "eve.verdict.passed": 0,
      "eve.gates.passed": 0,
      "eve.soft_thresholds.passed": 1,
    });
  });

  void it("surfaces failed assertions in datapoint metadata", async () => {
    mockInit();
    let createBody: RequestBody = {};
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
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

  void it("increments the datapoint index across evals", async () => {
    mockInit();
    const indices: number[] = [];
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        indices.push(b.points[0].index);
        return true;
      })
      .twice()
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
      .twice()
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }, { id: "b" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "scored",
      result: { status: "completed" },
      assertions: [{ name: "accuracy", score: 1, severity: "soft" }],
    });
    await reporter.onEvalComplete({
      id: "b",
      verdict: "scored",
      result: { status: "completed" },
      assertions: [{ name: "accuracy", score: 0, severity: "soft" }],
    });

    assert.deepStrictEqual(indices, [0, 1]);
  });

  void it("uses the same score keys for heterogeneous eve assertions", async () => {
    mockInit();
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`)
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

    assert.deepStrictEqual(
      scoreUpdates.map((body) => Object.keys(body.scores).sort()),
      [
        [
          "eve.gates.passed",
          "eve.soft_thresholds.passed",
          "eve.verdict.passed",
        ],
        [
          "eve.gates.passed",
          "eve.soft_thresholds.passed",
          "eve.verdict.passed",
        ],
      ],
    );
    assert.deepStrictEqual(scoreUpdates.map((body) => body.scores), [
      {
        "eve.verdict.passed": 1,
        "eve.gates.passed": 1,
        "eve.soft_thresholds.passed": 1,
      },
      {
        "eve.verdict.passed": 1,
        "eve.gates.passed": 1,
        "eve.soft_thresholds.passed": 1,
      },
    ]);
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

  void it("swallows datapoint errors so a bad eval never breaks the run", async () => {
    mockInit();
    nock(NOCK_URL).post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`).reply(500, "nope");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await assert.doesNotReject(() =>
      reporter.onEvalComplete({ id: "a", result: {}, assertions: [] }),
    );
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
      traceLookupAttempts: 1,
      traceLookupDelayMs: 0,
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
    const laminarContext = JSON.parse(headers["laminar-span-context"]);
    assert.strictEqual(laminarContext.traceId, otelTraceIdToUUID(traceIdHex));
    assert.strictEqual(laminarContext.isRemote, true);

    // A second turn on the same eve session reuses the same trace.
    await session.send({ message: "again", headers: { "x-user": "kolbe" } });
    const secondHeaders = headersOf(session.sentInputs[1]);
    assert.strictEqual(secondHeaders.traceparent, headers.traceparent);
    assert.strictEqual(secondHeaders["x-user"], "kolbe");

    await reporter.onRunComplete();
  });

  void it("resolves the datapoint trace from the propagated session with no SQL", async () => {
    mockInit();
    // Defined but must stay unused: the propagated path needs no lookup.
    const sqlScope = mockTraceLookup([{ trace_id: EVE_AGENT_TRACE_ID }]);
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

    assert.strictEqual(sqlScope.isDone(), false, "no session-id lookup expected");
    const point = createBody.points[0];
    assert.strictEqual(point.traceId, otelTraceIdToUUID(traceIdHex));
    assert.strictEqual(point.metadata.traceResolution, "propagated");
    assert.strictEqual(point.metadata.traceResolutionAttempt, 0);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "eve eval a");
    const executor = spans.find((span) => span.name === "executor");
    assert.ok(root, "expected a renamed EVALUATION root span");
    assert.ok(executor, "expected an EXECUTOR span");
    assert.strictEqual(root.attributes["lmnr.span.type"], "EVALUATION");
    assert.strictEqual(
      root.attributes["lmnr.association.properties.trace_type"],
      "EVALUATION",
    );
    assert.deepStrictEqual(root.attributes["lmnr.span.path"], ["eve eval a"]);
    assert.strictEqual(executor.attributes["lmnr.span.type"], "EXECUTOR");
    assert.deepStrictEqual(executor.attributes["lmnr.span.path"], [
      "eve eval a",
      "executor",
    ]);
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
    // Evaluator children carry an explicit parent path so the span processor
    // rebuilds the RENAMED root's path, not the placeholder one.
    assert.deepStrictEqual(
      evaluators[0].attributes["lmnr.span.parent_path"],
      ["eve eval a"],
    );
    assert.ok(evaluators.every(
      (span) => span.spanContext().traceId === root.spanContext().traceId,
    ));

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

    const roots = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["lmnr.span.type"] === "EVALUATION");
    assert.deepStrictEqual(
      roots.map((span) => span.name).sort(),
      ["eve eval a", "eve eval b"],
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

  void it("falls back to the session-id lookup when propagation is disabled", async () => {
    mockInit();
    let sqlBody: RequestBody = {};
    const sqlScope = mockTraceLookup(
      [{ trace_id: EVE_AGENT_TRACE_ID }],
      (b) => (sqlBody = b),
    );
    let createBody: RequestBody = {};
    mockDatapointWrites((b) => (createBody = b));

    const reporter = makeReporter({ propagateTraceContext: false });
    await reporter.onRunStart([{ id: "a" }], {});
    const SessionClass = makeStubSessionClass();
    patchEveClientSession(SessionClass);
    const session = new SessionClass("wrun_1");
    await session.send("hello");

    // The patch is installed but no factory is registered, so eve's payload is
    // untouched and the reporter has to query for the agent trace.
    assert.strictEqual(session.sentInputs[0], "hello");
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: { sessionId: "wrun_1", status: "waiting" },
      assertions: [],
    });

    sqlScope.done();
    assert.doesNotMatch(sqlBody.query, /lmnr\.eve\.session\.id/);
    assert.match(sqlBody.query, /eve\.session\.id/);
    assert.match(sqlBody.query, /workflow\.run\.id/);
    assert.strictEqual(createBody.points[0].traceId, EVE_AGENT_TRACE_ID);
    assert.strictEqual(
      createBody.points[0].metadata.traceResolution,
      "eve-session",
    );

    await reporter.onRunComplete();
  });

  void it("falls back when the graded session id was never propagated", async () => {
    mockInit();
    const sqlScope = mockTraceLookup([{ trace_id: EVE_AGENT_TRACE_ID }]);
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

    sqlScope.done();
    assert.strictEqual(
      createBody.points[0].metadata.traceResolution,
      "eve-session",
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
