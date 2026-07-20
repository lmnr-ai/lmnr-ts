import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type StringUUID } from "@lmnr-ai/types";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import {
  type EveEval,
  type EveEvalResult,
  type EveEvalTarget,
  LaminarReporter,
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
