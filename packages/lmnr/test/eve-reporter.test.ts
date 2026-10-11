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
  type EveEvalCompleteContext,
  type EveEvalResult,
  type EveEvalTarget,
  LaminarReporter,
} from "../src/integrations/eve";
import { Laminar } from "../src/laminar";
import { _configuration } from "../src/opentelemetry-lib/configuration";
import { otelTraceIdToUUID } from "../src/utils";

type RequestBody = Record<string, any>;

const scoresOf = (body: RequestBody): Record<string, number> =>
  body.scores as Record<string, number>;

const NOCK_URL = "https://api.lmnr.ai:443";
const PROJECT_API_KEY = "test-api-key";
const MOCK_EVAL_ID: StringUUID = "12345678-1234-1234-1234-123456789abc";
const NATIVE_TRACE_ID = "1".repeat(32);
const NATIVE_SPAN_ID = "2".repeat(16);
const SECONDARY_TRACE_ID = "3".repeat(32);
const SECONDARY_SPAN_ID = "4".repeat(16);

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

const mockDatapoint = () => {
  let createBody: RequestBody = {};
  let updateBody: RequestBody = {};
  const createScope = nock(NOCK_URL)
    .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (body: RequestBody) => {
      createBody = body;
      return true;
    })
    .reply(200, {});
  const updateScope = nock(NOCK_URL)
    .post(
      new RegExp(
        `/v1/evals/${MOCK_EVAL_ID}/datapoints/${DATAPOINT_ID_RE.source.slice(1, -1)}`,
      ),
      (body: RequestBody) => {
        updateBody = body;
        return true;
      },
    )
    .reply(200, {});
  return {
    createBody: () => createBody,
    updateBody: () => updateBody,
    done: () => {
      createScope.done();
      updateScope.done();
    },
  };
};

const nativeContext = (): EveEvalCompleteContext => ({
  evaluation: {
    id: "brooklyn-forecast",
    description: "Checks that the agent can answer with local weather.",
  },
  traceContexts: [
    {
      traceId: SECONDARY_TRACE_ID,
      spanId: SECONDARY_SPAN_ID,
      traceFlags: 1,
      primary: false,
      sessionId: "secondary-session",
    },
    {
      traceId: NATIVE_TRACE_ID,
      spanId: NATIVE_SPAN_ID,
      traceFlags: 1,
      primary: true,
      sessionId: "primary-session",
    },
  ],
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

  void afterEach(async () => {
    nock.cleanAll();
    await Laminar.shutdown();
  });

  void it("creates one Laminar evaluation on run start with eve metadata", async () => {
    let body: RequestBody = {};
    const scope = mockInit((value) => (body = value));

    const reporter = makeReporter();
    const evals: EveEval[] = [{ id: "a" }, { id: "b" }];
    const target: EveEvalTarget = {
      kind: "local",
      url: "http://localhost:1234",
    };
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
    const scope = mockInit((value) => (body = value));

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

  void it("links a datapoint to eve's primary native trace", async () => {
    mockInit();
    const requests = mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "brooklyn-forecast" }], { kind: "local" });

    const result: EveEvalResult = {
      id: "brooklyn-forecast",
      verdict: "passed",
      result: {
        output: "It is sunny.",
        finalMessage: "It is sunny.",
        sessionId: "primary-session",
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
    await reporter.onEvalComplete(result, nativeContext());

    const point = requests.createBody().points[0];
    assert.ok(DATAPOINT_ID_RE.test(point.id));
    assert.strictEqual(point.traceId, otelTraceIdToUUID(NATIVE_TRACE_ID));
    assert.strictEqual(point.data, "brooklyn-forecast");
    assert.strictEqual(point.target, "It is sunny.");
    assert.strictEqual(point.metadata.traceResolution, "eve-native");
    assert.strictEqual(
      point.metadata.description,
      "Checks that the agent can answer with local weather.",
    );
    assert.strictEqual(
      point.metadata.selectedTraceContext.sessionId,
      "primary-session",
    );
    assert.deepStrictEqual(
      point.metadata.traceContexts.map(
        (context: RequestBody) => context.traceId,
      ),
      [SECONDARY_TRACE_ID, NATIVE_TRACE_ID],
    );
    assert.deepStrictEqual(point.metadata.toolCalls, ["get_weather"]);
    assert.strictEqual(point.metadata.modelId, "gpt-4o-mini");

    assert.deepStrictEqual(requests.updateBody().scores, {
      "eve.verdict.passed": 1,
      "eve.gates.passed": 1,
      "eve.soft_thresholds.passed": 1,
    });
    assert.strictEqual(requests.updateBody().executorOutput, "It is sunny.");

    const spans = exporter.getFinishedSpans();
    const gradeSpan = spans.find(
      (span) => span.name === "eve eval brooklyn-forecast",
    );
    assert.ok(gradeSpan, "expected an EVALUATION span on eve's native trace");
    assert.strictEqual(gradeSpan.spanContext().traceId, NATIVE_TRACE_ID);
    assert.strictEqual(gradeSpan.attributes["lmnr.span.type"], "EVALUATION");
    assert.strictEqual(
      gradeSpan.attributes["lmnr.association.properties.trace_type"],
      "EVALUATION",
    );
    const parentSpanId =
      gradeSpan.parentSpanContext?.spanId ??
      (gradeSpan as unknown as { parentSpanId?: string }).parentSpanId;
    assert.strictEqual(parentSpanId, NATIVE_SPAN_ID);
    const assertionSpan = spans.find((span) => span.name === "no-refusal");
    assert.strictEqual(assertionSpan?.spanContext().traceId, NATIVE_TRACE_ID);
    assert.strictEqual(
      assertionSpan?.parentSpanContext?.spanId ??
        (assertionSpan as unknown as { parentSpanId?: string }).parentSpanId,
      gradeSpan.spanContext().spanId,
    );
    requests.done();
  });

  void it("uses result trace contexts when the completion context is absent", async () => {
    mockInit();
    const requests = mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: {
        traceContexts: [
          {
            traceId: NATIVE_TRACE_ID,
            spanId: NATIVE_SPAN_ID,
            traceFlags: 1,
            primary: true,
            sessionId: "session-a",
          },
        ],
      },
    });

    assert.strictEqual(
      requests.createBody().points[0].traceId,
      otelTraceIdToUUID(NATIVE_TRACE_ID),
    );
    assert.strictEqual(
      requests.createBody().points[0].metadata.traceResolution,
      "eve-native",
    );
    requests.done();
  });

  void it("creates a fallback trace when eve reports no usable trace", async () => {
    mockInit();
    const requests = mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete(
      { id: "a", verdict: "passed", result: { status: "waiting" } },
      {
        traceContexts: [
          { traceId: "invalid", spanId: "invalid", traceFlags: 1 },
        ],
      },
    );

    const fallback = exporter
      .getFinishedSpans()
      .find((span) => span.name === "eve eval a");
    assert.ok(fallback, "expected a reporter fallback span");
    const point = requests.createBody().points[0];
    assert.strictEqual(
      point.traceId,
      otelTraceIdToUUID(fallback.spanContext().traceId),
    );
    assert.strictEqual(point.metadata.traceResolution, "reporter-fallback");
    assert.deepStrictEqual(point.metadata.traceContexts, []);
    requests.done();
  });

  void it("ends the grade span when its output cannot be serialized", async () => {
    mockInit();
    mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    const circularOutput: Record<string, unknown> = {};
    circularOutput.self = circularOutput;

    await reporter.onEvalComplete({
      id: "a",
      verdict: "failed",
      result: { output: circularOutput },
    });

    assert.ok(
      exporter.getFinishedSpans().some((span) => span.name === "eve eval a"),
      "expected the grade span to end despite the serialization error",
    );
  });

  void it("uses a fallback trace when eve's only context is unsampled", async () => {
    mockInit();
    const requests = mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete(
      { id: "a", verdict: "passed", result: { status: "waiting" } },
      {
        traceContexts: [
          {
            traceId: NATIVE_TRACE_ID,
            spanId: NATIVE_SPAN_ID,
            traceFlags: 0,
            primary: true,
            sessionId: "unsampled-session",
          },
        ],
      },
    );

    const fallback = exporter
      .getFinishedSpans()
      .find((span) => span.name === "eve eval a");
    assert.ok(fallback, "expected a recording reporter fallback span");
    const point = requests.createBody().points[0];
    assert.strictEqual(
      point.traceId,
      otelTraceIdToUUID(fallback.spanContext().traceId),
    );
    assert.strictEqual(point.metadata.traceResolution, "reporter-fallback");
    assert.deepStrictEqual(point.metadata.traceContexts, [
      {
        traceId: NATIVE_TRACE_ID,
        spanId: NATIVE_SPAN_ID,
        traceFlags: 0,
        primary: true,
        sessionId: "unsampled-session",
      },
    ]);
    requests.done();
  });

  void it("selects a sampled secondary context over an unsampled primary", async () => {
    mockInit();
    const requests = mockDatapoint();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete(
      { id: "a", verdict: "passed", result: { status: "waiting" } },
      {
        traceContexts: [
          {
            traceId: NATIVE_TRACE_ID,
            spanId: NATIVE_SPAN_ID,
            traceFlags: 0,
            primary: true,
          },
          {
            traceId: SECONDARY_TRACE_ID,
            spanId: SECONDARY_SPAN_ID,
            traceFlags: 1,
            primary: false,
          },
        ],
      },
    );

    const point = requests.createBody().points[0];
    assert.strictEqual(point.traceId, otelTraceIdToUUID(SECONDARY_TRACE_ID));
    assert.strictEqual(point.metadata.traceResolution, "eve-native");
    assert.strictEqual(
      point.metadata.selectedTraceContext.traceId,
      SECONDARY_TRACE_ID,
    );
    assert.strictEqual(point.metadata.traceContexts.length, 2);
    requests.done();
  });

  void it("encodes a failed gate in both scores and metadata", async () => {
    mockInit();
    const requests = mockDatapoint();
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
          message: "no answer produced",
        },
      ],
    });

    assert.deepStrictEqual(requests.updateBody().scores, {
      "eve.verdict.passed": 0,
      "eve.gates.passed": 0,
      "eve.soft_thresholds.passed": 1,
    });
    assert.deepStrictEqual(
      requests.createBody().points[0].metadata.failedAssertions,
      [{ name: "must-answer", message: "no answer produced" }],
    );
    requests.done();
  });

  void it("uses stable score keys and discovery indexes for concurrent evals", async () => {
    mockInit();
    const indices: number[] = [];
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (body: RequestBody) => {
        indices.push(body.points[0].index);
        return true;
      })
      .twice()
      .reply(200, {});
    const scoreUpdates: RequestBody[] = [];
    nock(NOCK_URL)
      .post(
        new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`),
        (body: RequestBody) => {
          scoreUpdates.push(body);
          return true;
        },
      )
      .twice()
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }, { id: "b" }], {});
    // Eve runs evals concurrently, so completion order need not match discovery.
    await reporter.onEvalComplete({
      id: "b",
      verdict: "passed",
      result: {},
      assertions: [
        { name: "calledTool", score: 1, severity: "gate", passed: true },
      ],
    });
    await reporter.onEvalComplete({
      id: "a",
      verdict: "passed",
      result: {},
      assertions: [
        { name: "includes", score: 1, severity: "gate", passed: true },
      ],
    });

    const keys = [
      "eve.gates.passed",
      "eve.soft_thresholds.passed",
      "eve.verdict.passed",
    ];
    assert.deepStrictEqual(
      scoreUpdates.map((body) => Object.keys(scoresOf(body)).sort()),
      [keys, keys],
    );
    assert.deepStrictEqual(indices, [1, 0]);
  });

  void it("does not report results when run initialization failed", async () => {
    nock(NOCK_URL).post("/v1/evals").reply(500, "boom");
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await assert.doesNotReject(() => reporter.onEvalComplete({ id: "a" }));
    await assert.doesNotReject(() => reporter.onRunComplete({}));
    assert.deepStrictEqual(exporter.getFinishedSpans(), []);
  });

  void it("swallows datapoint errors so reporting never breaks the run", async () => {
    mockInit();
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`)
      .reply(500, "nope");
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await assert.doesNotReject(() =>
      reporter.onEvalComplete({ id: "a", result: {}, assertions: [] }),
    );
  });

  void it("flushes spans on run complete", async () => {
    mockInit();
    const originalFlush = Laminar.flush.bind(Laminar);
    let flushes = 0;
    Laminar.flush = () => {
      flushes += 1;
      return Promise.resolve();
    };
    try {
      const reporter = makeReporter();
      await reporter.onRunStart([{ id: "a" }], {});
      await reporter.onRunComplete({});
      assert.strictEqual(flushes, 1);
    } finally {
      Laminar.flush = originalFlush;
    }
  });

  void it("registers no auto-instrumentations when it initializes tracing", async () => {
    mockInit();
    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    assert.ok(Laminar.initialized());
    assert.deepStrictEqual(_configuration?.instrumentModules, {});
  });

  void it("reuses tracing that was already initialized", async () => {
    mockInit();
    const requests = mockDatapoint();
    const hostExporter = new InMemorySpanExporter();
    Laminar.initialize({
      projectApiKey: PROJECT_API_KEY,
      spanProcessor: new SimpleSpanProcessor(hostExporter),
      disableBatch: true,
    });

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete(
      { id: "a", verdict: "passed", result: {} },
      {
        traceContexts: [
          {
            traceId: NATIVE_TRACE_ID,
            spanId: NATIVE_SPAN_ID,
            traceFlags: 1,
            primary: true,
          },
        ],
      },
    );

    assert.deepStrictEqual(exporter.getFinishedSpans(), []);
    assert.ok(
      hostExporter
        .getFinishedSpans()
        .some((span) => span.name === "eve eval a"),
    );
    requests.done();
  });
});
