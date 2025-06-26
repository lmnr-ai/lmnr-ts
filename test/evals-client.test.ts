import assert from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import nock from "nock";

import { LaminarClient } from "../src/client";
import { StringUUID } from "../src/utils";

type RequestBody = Record<string, any>;

void describe("EvalsResource Client Methods", () => {
  const baseUrl = "https://api.lmnr.ai:443";
  const projectApiKey = "test-api-key";
  let client: LaminarClient;

  void beforeEach(() => {
    client = new LaminarClient({
      baseUrl: "https://api.lmnr.ai",
      projectApiKey,
    });
  });

  void after(() => {
    nock.cleanAll();
  });

  void describe("createEvaluation", () => {
    void it("creates an evaluation and returns the ID", async () => {
      const mockEvalId: StringUUID = "12345678-1234-1234-1234-123456789abc";
      const evalName = "Test Evaluation";
      const groupName = "Test Group";
      const metadata = { metadata: "test metadata"}

      const scope = nock(baseUrl)
        .post('/v1/evals', {
          name: evalName,
          groupName: groupName,
          metadata,
        })
        .reply(200, {
          id: mockEvalId,
          createdAt: new Date().toISOString(),
          groupId: "group-123",
          name: evalName,
          metadata,
          projectId: "project-123",
        });

      const result = await client.evals.createEvaluation(evalName, groupName, metadata);

      assert.strictEqual(result, mockEvalId);
      scope.done();
    });

    void it("creates an evaluation with optional parameters", async () => {
      const mockEvalId: StringUUID = "12345678-1234-1234-1234-123456789abc";

      const scope = nock(baseUrl)
        .post('/v1/evals', {
          name: null,
          groupName: null,
          metadata: null,
        })
        .reply(200, {
          id: mockEvalId,
          createdAt: new Date().toISOString(),
          groupId: "group-123",
          name: null,
          metadata: null,
          projectId: "project-123",
        });

      const result = await client.evals.createEvaluation();

      assert.strictEqual(result, mockEvalId);
      scope.done();
    });

    void it("handles API errors", async () => {
      const scope = nock(baseUrl)
        .post('/v1/evals')
        .reply(400, "Bad Request");

      await assert.rejects(
        () => client.evals.createEvaluation("Test"),
        (error: Error) => {
          assert.ok(error.message.includes("400"));
          return true;
        }
      );

      scope.done();
    });
  });

  void describe("createDatapoint", () => {
    void it("creates a datapoint and returns the ID", async () => {
      const evalId = "eval-123";
      const testData = { input: "test input" };
      const testTarget = { expected: "test output" };
      const testMetadata = { source: "test" };
      const testIndex = 5;
      const testTraceId = "trace-123";

      let capturedBody: RequestBody = {};

      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      const result = await client.evals.createDatapoint({
        evalId,
        data: testData,
        target: testTarget,
        metadata: testMetadata,
        index: testIndex,
        traceId: testTraceId,
      });

      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result));

      assert.strictEqual(capturedBody.points.length, 1);
      const point = capturedBody.points[0];

      assert.strictEqual(point.id, result);
      assert.deepStrictEqual(point.data, testData);
      assert.deepStrictEqual(point.target, testTarget);
      assert.deepStrictEqual(point.metadata, testMetadata);
      assert.strictEqual(point.index, testIndex);
      assert.strictEqual(point.traceId, testTraceId);
      assert.ok(point.executorSpanId);

      scope.done();
    });

    void it("creates a datapoint with minimal parameters", async () => {
      const evalId = "eval-123";
      const testData = { input: "test input" };

      let capturedBody: RequestBody = {};

      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      const result = await client.evals.createDatapoint({
        evalId,
        data: testData,
      });

      // Verify the returned ID is a valid UUID
      assert.ok(typeof result === 'string');
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result));

      // Verify the request body
      assert.strictEqual(capturedBody.points.length, 1);
      const point = capturedBody.points[0];

      assert.strictEqual(point.id, result);
      assert.deepStrictEqual(point.data, testData);
      assert.strictEqual(point.target, undefined);
      assert.strictEqual(point.metadata, undefined);
      assert.strictEqual(point.index, 0);
      assert.ok(point.traceId);
      assert.ok(point.executorSpanId);

      scope.done();
    });

    void it("handles API errors", async () => {
      const scope = nock(baseUrl)
        .post('/v1/evals/eval-123/datapoints')
        .reply(500, "Internal Server Error");

      await assert.rejects(
        () => client.evals.createDatapoint({
          evalId: "eval-123",
          data: { input: "test" },
        }),
        (error: Error) => {
          assert.ok(error.message.includes("500"));
          return true;
        }
      );

      scope.done();
    });
  });

  void describe("updateDatapoint", () => {
    void it("updates a datapoint with scores and executor output", async () => {
      const evalId = "eval-123";
      const datapointId = "datapoint-456";
      const testScores = { accuracy: 0.95, relevance: 0.8 };
      const testOutput = { result: "test result" };

      let capturedBody: RequestBody = {};

      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints/${datapointId}`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      await client.evals.updateDatapoint({
        evalId,
        datapointId,
        scores: testScores,
        executorOutput: testOutput,
      });

      // Verify the request body
      assert.deepStrictEqual(capturedBody.executorOutput, testOutput);
      assert.deepStrictEqual(capturedBody.scores, testScores);

      scope.done();
    });

    void it("updates a datapoint with only scores", async () => {
      const evalId = "eval-123";
      const datapointId = "datapoint-456";
      const testScores = { accuracy: 1.0 };

      let capturedBody: RequestBody = {};

      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints/${datapointId}`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      await client.evals.updateDatapoint({
        evalId,
        datapointId,
        scores: testScores,
      });

      // Verify the request body
      assert.strictEqual(capturedBody.executorOutput, undefined);
      assert.deepStrictEqual(capturedBody.scores, testScores);

      scope.done();
    });

    void it("handles API errors", async () => {
      const scope = nock(baseUrl)
        .post('/v1/evals/eval-123/datapoints/datapoint-456')
        .reply(404, "Not Found");

      await assert.rejects(
        () => client.evals.updateDatapoint({
          evalId: "eval-123",
          datapointId: "datapoint-456",
          scores: { test: 1.0 },
        }),
        (error: Error) => {
          assert.ok(error.message.includes("404"));
          return true;
        }
      );

      scope.done();
    });
  });

  void describe("Integration workflow", () => {
    void it("supports a complete evaluation workflow", async () => {
      const mockEvalId: StringUUID = "12345678-1234-1234-1234-123456789abc";
      const evalName = "Integration Test";

      const createEvalScope = nock(baseUrl)
        .post('/v1/evals', {
          name: evalName,
          groupName: null,
          metadata: null,
        })
        .reply(200, {
          id: mockEvalId,
          createdAt: new Date().toISOString(),
          groupId: "group-123",
          name: evalName,
          metadata: null,
          projectId: "project-123",
        });

      const createDatapointScope = nock(baseUrl)
        .post(`/v1/evals/${mockEvalId}/datapoints`)
        .reply(200, {});

      const updateDatapointScope = nock(baseUrl)
          .post(new RegExp(`/v1/evals/${mockEvalId}/datapoints/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`))
          .reply(200, {});

      const evalId = await client.evals.createEvaluation(evalName);

      assert.strictEqual(evalId, mockEvalId);

      const dataId = await client.evals.createDatapoint({
        evalId,
        data: { question: "What is 2+2?" },
        target: { answer: "4" },
      });

      await client.evals.updateDatapoint({
        evalId,
        datapointId: dataId,
        scores: { correctness: 1.0 },
        executorOutput: { answer: "4" },
      });

      createEvalScope.done();
      createDatapointScope.done();
      updateDatapointScope.done();
    });
  });
}); 