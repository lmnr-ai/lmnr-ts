import assert from "node:assert";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import {
  Dataset,
  evaluate,
  HumanEvaluator,
  Laminar,
  LaminarDataset,
} from "../src/index";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

type RequestBody = Record<string, any>;

void describe("evaluate", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("evaluation exports an evaluation, executor, and evaluator spans", async () => {
    const baseUrl = "https://api.lmnr.ai";
    const mockEvalId = "00000000-0000-0000-0000-000000000000";

    // spy into request body
    let body: RequestBody = {};

    nock(baseUrl).post("/v1/evals").reply(200, {
      id: mockEvalId,
      projectId: "mock-project-id",
    });

    nock(baseUrl)
      .post(
        `/v1/evals/${mockEvalId}/datapoints`,
        (requestBody: RequestBody): boolean => {
          body = requestBody;
          return true;
        },
      )
      .times(2)
      .reply(200, {});

    await evaluate({
      data: [
        {
          data: "a".repeat(150),
          target: "b".repeat(150),
          metadata: {
            test: "test",
          },
        },
      ],
      executor: (data) => data,
      evaluators: {
        test: (output, target) => (output === target ? 1 : 0),
        test2: (output, target) => (output === target ? 1 : 0),
      },
      config: {
        projectApiKey: "test",
      },
    });

    await Laminar.flush();

    assert.strictEqual(body?.points?.length, 1);

    const point = body.points[0];
    assert.strictEqual(point.data.length, 150);
    assert.strictEqual(point.target.length, 150);
    assert.strictEqual(point.index, 0);
    assert.strictEqual(point.taskId, "0");
    assert.deepStrictEqual(point.metadata, { test: "test" });
    assert.deepStrictEqual(point.scores, { test2: 0, test: 0 });

    // Check that generated fields exist but don't check their exact values
    assert.ok(point.executorSpanId);
    assert.ok(point.id);
    assert.ok(point.traceId);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 4);
    const evaluationSpan = spans.find(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATION",
    );
    const executorSpan = spans.find(
      (span) => span.attributes["lmnr.span.type"] === "EXECUTOR",
    );
    assert.strictEqual(
      String(executorSpan?.attributes["lmnr.span.output"]),
      "a".repeat(150),
    );
    const evaluatorSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATOR",
    );
    assert.strictEqual(evaluationSpan?.name, "evaluation");
    assert.strictEqual(executorSpan?.name, "executor");
    assert.deepStrictEqual(evaluatorSpans.map((span) => span.name).sort(), [
      "test",
      "test2",
    ]);

    // Every span produced under the evaluation should carry the evaluation id
    for (const span of spans) {
      assert.strictEqual(
        span.attributes["lmnr.association.properties.metadata.evaluation_id"],
        mockEvalId,
        `span "${span.name}" missing evaluation_id metadata association property`,
      );
    }
  });

  void it("parallel evaluation exports an evaluation, executor, and evaluator spans", async () => {
    const baseUrl = "https://api.lmnr.ai";
    const mockEvalId = "00000000-0000-0000-0000-000000000000";

    // spy into request body
    let body: RequestBody = {};

    nock(baseUrl).post("/v1/evals").times(1).reply(200, {
      id: mockEvalId,
      projectId: "mock-project-id",
    });

    nock(baseUrl)
      .post(
        `/v1/evals/${mockEvalId}/datapoints`,
        (requestBody: RequestBody): boolean => {
          body = requestBody;
          return true;
        },
      )
      .times(2)
      .reply(200, {});

    nock(baseUrl).post("/v1/evals").times(1).reply(200, {
      id: mockEvalId,
      projectId: "mock-project-id",
    });

    nock(baseUrl)
      .post(
        `/v1/evals/${mockEvalId}/datapoints`,
        (requestBody: RequestBody): boolean => {
          body = requestBody;
          return true;
        },
      )
      .times(2)
      .reply(200, {});

    await evaluate({
      data: [
        {
          data: "a".repeat(150),
          target: "b".repeat(150),
          metadata: {
            test: "test",
          },
        },
        {
          data: "x".repeat(150),
          target: "y".repeat(150),
          metadata: {
            test: "test",
          },
        },
      ],
      executor: (data) => data,
      evaluators: {
        test: (output, target) => (output === target ? 1 : 0),
        test2: (output, target, data) => (output === data ? 1 : 0),
      },
      config: {
        projectApiKey: "test",
      },
    });

    await Laminar.flush();

    assert.strictEqual(body?.points?.length, 1);

    const point = body.points[0];
    assert.strictEqual(point.data.length, 150);
    assert.strictEqual(point.target.length, 150);
    assert.strictEqual(point.index, 1);
    assert.deepStrictEqual(point.metadata, { test: "test" });
    assert.deepStrictEqual(point.scores, { test2: 1, test: 0 });

    // Check that generated fields exist but don't check their exact values
    assert.ok(point.executorSpanId);
    assert.ok(point.id);
    assert.ok(point.traceId);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 8);
    const traceIds = Array.from(
      new Set(spans.map((span) => span.spanContext().traceId)),
    );
    assert.strictEqual(traceIds.length, 2);

    const evaluationSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATION",
    );
    const executorSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EXECUTOR",
    );
    const evaluatorSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATOR",
    );
    assert.strictEqual(evaluationSpans.length, 2);
    assert.strictEqual(executorSpans.length, 2);
    assert.strictEqual(evaluatorSpans.length, 4);
    assert.deepStrictEqual(
      Array.from(new Set(evaluatorSpans.map((span) => span.name))).sort(),
      ["test", "test2"],
    );
    const testSpan = evaluatorSpans.find((span) => span.name === "test")!;
    const test2Span = evaluatorSpans.find((span) => span.name === "test2")!;
    assert.strictEqual(testSpan.attributes["lmnr.span.output"], "0");
    assert.strictEqual(test2Span.attributes["lmnr.span.output"], "1");
    assert.deepStrictEqual(
      JSON.parse(String(testSpan.attributes["lmnr.span.input"])),
      ["a".repeat(150), "b".repeat(150), "a".repeat(150)],
    );
    assert.deepStrictEqual(
      JSON.parse(String(test2Span.attributes["lmnr.span.input"])),
      ["a".repeat(150), "b".repeat(150), "a".repeat(150)],
    );
  });

  void it("evaluation with human evaluators exports human evaluator spans", async () => {
    const baseUrl = "https://api.lmnr.ai";
    const mockEvalId = "00000000-0000-0000-0000-000000000000";

    let body: RequestBody = {};

    nock(baseUrl).post("/v1/evals").reply(200, {
      id: mockEvalId,
      projectId: "mock-project-id",
    });

    nock(baseUrl)
      .post(
        `/v1/evals/${mockEvalId}/datapoints`,
        (requestBody: RequestBody): boolean => {
          body = requestBody;
          return true;
        },
      )
      .times(2)
      .reply(200, {});

    await evaluate({
      data: [
        {
          data: "test input",
          target: "test target",
          metadata: {
            test: "test",
          },
        },
      ],
      executor: (data) => `output for ${data}`,
      evaluators: {
        automatic: (output, target) => (output.includes(target || "") ? 1 : 0),
        human_quality: new HumanEvaluator(),
        human_relevance: new HumanEvaluator([{ value: 1, label: "label" }]),
      },
      config: {
        projectApiKey: "test",
      },
    });

    await Laminar.flush();

    assert.strictEqual(body?.points?.length, 1);

    const point = body.points[0];
    assert.strictEqual(point.index, 0);
    assert.deepStrictEqual(point.metadata, { test: "test" });

    assert.strictEqual(point.scores.automatic, 0);
    assert.strictEqual(point.scores.human_quality, null);
    assert.strictEqual(point.scores.human_relevance, null);

    assert.ok(point.executorSpanId);
    assert.ok(point.id);
    assert.ok(point.traceId);

    const spans = exporter.getFinishedSpans();
    // evaluation + executor + 1 automatic evaluator + 2 human evaluators
    assert.strictEqual(spans.length, 5);

    const evaluationSpan = spans.find(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATION",
    );
    assert.strictEqual(evaluationSpan?.name, "evaluation");

    const executorSpan = spans.find(
      (span) => span.attributes["lmnr.span.type"] === "EXECUTOR",
    );
    assert.strictEqual(executorSpan?.name, "executor");

    const automaticEvaluatorSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "EVALUATOR",
    );
    assert.strictEqual(automaticEvaluatorSpans.length, 1);
    assert.strictEqual(automaticEvaluatorSpans[0].name, "automatic");

    const humanEvaluatorSpans = spans.filter(
      (span) => span.attributes["lmnr.span.type"] === "HUMAN_EVALUATOR",
    );

    const humanEvaluatorSpanWithOptions = humanEvaluatorSpans.find(
      (s) => s.name === "human_relevance",
    );

    const options =
      humanEvaluatorSpanWithOptions?.attributes?.[
        "lmnr.span.human_evaluator_options"
      ];

    assert.strictEqual(!!options, true);
    assert.deepStrictEqual(JSON.parse(String(options)), [
      { value: 1, label: "label" },
    ]);
    assert.strictEqual(humanEvaluatorSpans.length, 2);
    assert.deepStrictEqual(
      humanEvaluatorSpans.map((span) => span.name).sort(),
      ["human_quality", "human_relevance"],
    );
  });
});

// LAM-1909: evals stream Trials through a semaphore sliding window and
// retain nothing for the whole run.
void describe("evaluate streaming", () => {
  const baseUrl = "https://api.lmnr.ai";
  const mockEvalId = "00000000-0000-0000-0000-000000000000";
  const exporter = new InMemorySpanExporter();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // A result save carries scores; the initial (partial) save does not.
  const isResultSave = (body: RequestBody): boolean =>
    (body.points ?? []).some((p: RequestBody) => "scores" in p);

  const mockEvalInit = () =>
    nock(baseUrl)
      .post("/v1/evals")
      .reply(200, { id: mockEvalId, projectId: "mock-project-id" });

  const mockSavesOk = () =>
    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`)
      .reply(200, {})
      .persist();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });

  void afterEach(() => {
    exporter.reset();
    nock.cleanAll();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("pulls a LaminarDataset page by page without caching streamed pages", async () => {
    const total = 5;
    const pulledOffsets: number[] = [];
    nock(baseUrl)
      .get("/v1/datasets/datapoints")
      .query(true)
      .reply((uri) => {
        const params = new URL(uri, baseUrl).searchParams;
        const offset = Number(params.get("offset"));
        const limit = Number(params.get("limit"));
        pulledOffsets.push(offset);
        const items = [];
        for (let i = offset; i < Math.min(offset + limit, total); i++) {
          items.push({
            data: i,
            id: `dp-${i}`,
            createdAt: "2024-01-01T00:00:00Z",
          });
        }
        return [200, { items, totalCount: total }];
      })
      .persist();
    mockEvalInit();
    mockSavesOk();

    const dataset = new LaminarDataset<number, number>(undefined, {
      id: "11111111-1111-1111-1111-111111111111",
      fetchSize: 2,
    });
    const result = await evaluate({
      data: dataset,
      executor: (data) => data,
      evaluators: {
        parity: (output) => output % 2,
        // All-null scores are left out of the averages instead of being NaN.
        human: new HumanEvaluator(),
      },
      config: { projectApiKey: "test", concurrencyLimit: 2 },
    });

    assert.strictEqual(result?.errorMessage, undefined);
    assert.deepStrictEqual(result?.averageScores, { parity: 0.4 });
    // Page 0 is pulled once for the progress bar's length and then served
    // from cache; every later page is pulled exactly once while streaming.
    assert.deepStrictEqual(pulledOffsets, [0, 2, 4]);
    const pages = (dataset as unknown as { pages: Map<number, unknown> }).pages;
    assert.deepStrictEqual([...pages.keys()], [0]);
  });

  const captureResultSaves = () => {
    const saved: RequestBody[] = [];
    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`, (body: RequestBody) => {
        if (isResultSave(body)) {
          saved.push(...body.points);
        }
        return true;
      })
      .reply(200, {})
      .persist();
    return saved;
  };

  void it("runs each Task `trials` times sharing its index and renames duplicate taskIds", async () => {
    mockEvalInit();
    const saved = captureResultSaves();

    const result = await evaluate({
      data: [{ data: 0, taskId: "x" }, { data: 1, taskId: "x" }, { data: 2 }],
      executor: (data: number) => data,
      evaluators: { value: (output: number) => output },
      config: { projectApiKey: "test", trials: 2 },
    });

    assert.strictEqual(result?.errorMessage, undefined);
    const byIndex = saved.sort((a, b) => a.index - b.index);
    assert.deepStrictEqual(
      byIndex.map((p) => [p.index, p.data, p.taskId]),
      [
        [0, 0, "x"],
        [0, 0, "x"],
        [1, 1, "x#2"],
        [1, 1, "x#2"],
        [2, 2, "2"],
        [2, 2, "2"],
      ],
    );
    assert.strictEqual(new Set(byIndex.map((p) => p.id)).size, 6);
    assert.strictEqual(new Set(byIndex.map((p) => p.traceId)).size, 6);
  });

  for (const [input, expected] of [
    [
      ["foo", "foo", "foo#2", "foo"],
      ["foo", "foo#2", "foo#2#2", "foo#3"],
    ],
    [
      ["foo", "foo#2", "foo"],
      ["foo", "foo#2", "foo#3"],
    ],
  ]) {
    void it(`renames duplicate taskIds ${input.join(",")} to unused ids`, async () => {
      mockEvalInit();
      const saved = captureResultSaves();

      await evaluate({
        data: input.map((taskId, data) => ({ data, taskId })),
        executor: (data: number) => data,
        evaluators: { value: (output: number) => output },
        config: { projectApiKey: "test", concurrencyLimit: 1 },
      });

      assert.deepStrictEqual(
        saved.sort((a, b) => a.index - b.index).map((p) => p.taskId),
        expected,
      );
    });
  }

  void it("defaults taskId to the source index through chained transforms", async () => {
    mockEvalInit();
    const saved = captureResultSaves();

    class ArrayDataset extends Dataset<number, number> {
      size = () => 4;
      get = (i: number) => ({ data: i * 10 });
    }

    await evaluate({
      // The same source datapoint selected twice is two Trials, not renamed.
      data: new ArrayDataset().select([3, 1, 3, 2]).take(3),
      executor: (data: number) => data,
      evaluators: { value: (output: number) => output },
      config: { projectApiKey: "test" },
    });

    assert.deepStrictEqual(
      saved.sort((a, b) => a.index - b.index).map((p) => [p.data, p.taskId]),
      [
        [30, "3"],
        [10, "1"],
        [30, "3"],
      ],
    );
  });

  void it("rejects a non-integer trials count", async () => {
    await assert.rejects(
      evaluate({
        data: [{ data: 0 }],
        executor: (data: number) => data,
        evaluators: { value: (output: number) => output },
        config: { projectApiKey: "test", trials: 1.5 },
      }),
      /trials must be a positive integer/,
    );
  });

  void it("keeps up to concurrencyLimit Trials in flight", async () => {
    mockEvalInit();
    mockSavesOk();

    let inFlight = 0;
    let maxInFlight = 0;
    const result = await evaluate({
      data: Array.from({ length: 10 }, (_, i) => ({ data: i })),
      executor: async (data: number) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(10);
        inFlight -= 1;
        return data;
      },
      evaluators: { value: (output: number) => output },
      config: { projectApiKey: "test", concurrencyLimit: 3 },
    });

    assert.strictEqual(maxInFlight, 3);
    assert.deepStrictEqual(result?.averageScores, { value: 4.5 });
  });

  void it("a failing Trial does not stop the remaining ones", async () => {
    mockEvalInit();
    mockSavesOk();

    const executed: number[] = [];
    const result = await evaluate({
      data: Array.from({ length: 6 }, (_, i) => ({ data: i })),
      executor: async (data: number) => {
        executed.push(data);
        if (data === 1) {
          throw new Error("boom");
        }
        await sleep(5);
        return data;
      },
      evaluators: { value: (output: number) => output },
      config: { projectApiKey: "test", concurrencyLimit: 2 },
    });

    assert.deepStrictEqual(
      executed.sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
    );
    assert.match(result?.errorMessage ?? "", /boom/);
  });

  void it("a failing result save does not abandon the remaining saves", async () => {
    mockEvalInit();

    let resultSaves = 0;
    let completedResultSaves = 0;
    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`)
      .reply(async (_uri, body) => {
        if (!isResultSave(body as RequestBody)) {
          return [200, {}];
        }
        resultSaves += 1;
        // The first Trial's result save fails at once; the others are
        // still in flight when it does.
        if (resultSaves === 1) {
          return [500, { error: "save failed" }];
        }
        await sleep(30);
        completedResultSaves += 1;
        return [200, {}];
      })
      .persist();

    const result = await evaluate({
      data: Array.from({ length: 4 }, (_, i) => ({ data: i })),
      executor: (data: number) => data,
      evaluators: { value: (output: number) => output },
      config: { projectApiKey: "test", concurrencyLimit: 1 },
    });

    assert.ok(result?.errorMessage, "expected the failed save to surface");
    assert.strictEqual(completedResultSaves, 3);
  });
});
