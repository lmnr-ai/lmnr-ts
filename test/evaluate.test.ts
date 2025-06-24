import assert from "node:assert";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { evaluate, Laminar, HumanEvaluator } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

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

    nock(baseUrl)
      .post('/v1/evals')
      .reply(200, {
        id: mockEvalId,
        projectId: "mock-project-id",
      });

    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`, (requestBody: RequestBody): boolean => {
        body = requestBody;
        return true;
      })
      .times(2)
      .reply(200, {});

    await evaluate({
      data: [
        {
          data: "a".repeat(150),
          target: "b".repeat(150),
          metadata: {
            "test": "test",
          },
        },
      ],
      executor: (data) => data,
      evaluators: {
        "test": (output, target) => output === target ? 1 : 0,
        "test2": (output, target) => output === target ? 1 : 0,
      },
      config: {
        projectApiKey: "test",
      },
    });

    await Laminar.flush();


    assert.strictEqual(body?.points?.length, 1);

    const point = body.points[0];
    // test that the data and target are sliced to 100 characters + ...
    assert.strictEqual(point.data.length, 103);
    assert.strictEqual(point.target.length, 103);
    assert.strictEqual(point.index, 0);
    assert.deepStrictEqual(point.metadata, { test: 'test' });
    assert.deepStrictEqual(point.scores, { test2: 0, test: 0 });

    // Check that generated fields exist but don't check their exact values
    assert.ok(point.executorSpanId);
    assert.ok(point.id);
    assert.ok(point.traceId);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 4);
    const evaluationSpan = spans.find(
      (span) => span.attributes['lmnr.span.type'] === "EVALUATION",
    );
    const executorSpan = spans.find((span) => span.attributes['lmnr.span.type'] === "EXECUTOR");
    const evaluatorSpans = spans.filter(
      (span) => span.attributes['lmnr.span.type'] === "EVALUATOR",
    );
    assert.strictEqual(evaluationSpan?.name, "evaluation");
    assert.strictEqual(executorSpan?.name, "executor");
    assert.deepStrictEqual(evaluatorSpans.map((span) => span.name).sort(), ["test", "test2"]);
  });

  void it("evaluation with human evaluators exports human evaluator spans", async () => {
    const baseUrl = "https://api.lmnr.ai";
    const mockEvalId = "00000000-0000-0000-0000-000000000000";

    let body: RequestBody = {};

    nock(baseUrl)
      .post('/v1/evals')
      .reply(200, {
        id: mockEvalId,
        projectId: "mock-project-id",
      });

    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`, (requestBody: RequestBody): boolean => {
        body = requestBody;
        return true;
      })
      .times(2)
      .reply(200, {});

    await evaluate({
      data: [
        {
          data: "test input",
          target: "test target",
          metadata: {
            "test": "test",
          },
        },
      ],
      executor: (data) => `output for ${data}`,
      evaluators: {
        "automatic": (output, target) => output.includes(target || "") ? 1 : 0,
        "human_quality": new HumanEvaluator(),
        "human_relevance": new HumanEvaluator(),
      },
      config: {
        projectApiKey: "test",
      },
    });

    await Laminar.flush();

    assert.strictEqual(body?.points?.length, 1);

    const point = body.points[0];
    assert.strictEqual(point.index, 0);
    assert.deepStrictEqual(point.metadata, { test: 'test' });

    assert.strictEqual(point.scores.automatic, 0);
    assert.strictEqual(point.scores.human_quality, null);
    assert.strictEqual(point.scores.human_relevance, null);

    assert.ok(point.executorSpanId);
    assert.ok(point.id);
    assert.ok(point.traceId);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 5); // evaluation + executor + 1 automatic evaluator + 2 human evaluators

    const evaluationSpan = spans.find(
      (span) => span.attributes['lmnr.span.type'] === "EVALUATION",
    );
    assert.strictEqual(evaluationSpan?.name, "evaluation");

    const executorSpan = spans.find((span) => span.attributes['lmnr.span.type'] === "EXECUTOR");
    assert.strictEqual(executorSpan?.name, "executor");

    const automaticEvaluatorSpans = spans.filter(
      (span) => span.attributes['lmnr.span.type'] === "EVALUATOR",
    );
    assert.strictEqual(automaticEvaluatorSpans.length, 1);
    assert.strictEqual(automaticEvaluatorSpans[0].name, "automatic");

    const humanEvaluatorSpans = spans.filter(
      (span) => span.attributes['lmnr.span.type'] === "HUMAN_EVALUATOR",
    );
    assert.strictEqual(humanEvaluatorSpans.length, 2);
    assert.deepStrictEqual(
      humanEvaluatorSpans.map((span) => span.name).sort(),
      ["human_quality", "human_relevance"]
    );
  });
});
