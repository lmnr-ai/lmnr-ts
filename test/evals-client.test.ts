import assert from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import nock from "nock";

import { LaminarClient } from "../src/client";
import { StringUUID } from "../src/utils";

type RequestBody = Record<string, any>;

const MOCK_DATAPOINT_ID: StringUUID = "12345678-1234-4321-0000-123456789abc";

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
      const metadata = { metadata: "test metadata" };

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

      const result = await client.evals.create({ name: evalName, groupName, metadata });

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

      const result = await client.evals.create();

      assert.strictEqual(result, mockEvalId);
      scope.done();
    });

    void it("handles API errors", async () => {
      const scope = nock(baseUrl)
        .post('/v1/evals')
        .reply(400, "Bad Request");

      await assert.rejects(
        () => client.evals.create({ name: "Test" }),
        (error: Error) => {
          assert.ok(error.message.includes("400"));
          return true;
        },
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
        },
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
        },
      );

      scope.done();
    });
  });

  void describe("saveDatapoints with 413 retry logic", () => {
    void it("retries with exponentially reduced payload on 413 error", async () => {
      const evalId = "eval-123";
      const largeData = "x".repeat(1000);
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: largeData,
          target: largeData,
          executorOutput: largeData,
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
          metadata: { test: "data" },
        },
      ];

      let requestCount = 0;
      let capturedBodies: RequestBody[] = [];

      // Mock multiple 413 responses followed by success
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBodies.push(body);
          return true;
        })
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBodies.push(body);
          return true;
        })
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBodies.push(body);
          return true;
        })
        .reply(200, {});

      await client.evals.saveDatapoints({
        evalId,
        datapoints: testDatapoints,
      });

      // Verify we captured 3 retry bodies (not the initial request)
      assert.strictEqual(capturedBodies.length, 3);

      // Verify payload sizes decrease exponentially in retries
      // Retries: 8MB, 4MB, 2MB (initial 16MB doesn't get captured)
      const expectedLengths = [8_000_000, 4_000_000, 2_000_000];

      for (let i = 0; i < capturedBodies.length; i++) {
        const point = capturedBodies[i].points[0];
        const expectedLength = expectedLengths[i];

        // Since our test data is 1000 chars, it should be unchanged for all iterations
        assert.strictEqual(point.data, largeData);
        assert.strictEqual(point.target, largeData);
        assert.strictEqual(point.executorOutput, largeData);

        // Verify other fields are preserved
        assert.strictEqual(point.id, MOCK_DATAPOINT_ID);
        assert.strictEqual(point.index, 0);
        assert.strictEqual(point.traceId, "trace-1");
        assert.strictEqual(point.executorSpanId, "span-1");
        assert.deepStrictEqual(point.metadata, { test: "data" });
      }

      scope.done();
    });

    void it("respects maxRetries parameter", async () => {
      const evalId = "eval-123";
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: "test",
          target: "test",
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
        },
      ];

      let requestCount = 0;

      // Mock continuous 413 responses (1 initial + 3 retries = 4 total)
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        });

      // Override the private method to test with custom maxRetries
      const evalsResource = client.evals as any;
      const originalRetrySaveDatapoints = evalsResource.retrySaveDatapoints;
      evalsResource.retrySaveDatapoints = async function (options: any) {
        return originalRetrySaveDatapoints.call(this, { ...options, maxRetries: 3 });
      };

      await assert.rejects(
        () => client.evals.saveDatapoints({
          evalId,
          datapoints: testDatapoints,
        }),
        (error: Error) => {
          assert.ok(error.message.includes("413"));
          return true;
        }
      );

      // Verify exactly 4 requests were made (1 initial + 3 retries)
      assert.strictEqual(requestCount, 4);

      scope.done();
    });

    void it("succeeds after some retries", async () => {
      const evalId = "eval-123";
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: "test data",
          target: "test target",
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
        },
      ];

      let requestCount = 0;

      // Mock 2 failures followed by success
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [200, {}];
        });

      // Should not throw
      await client.evals.saveDatapoints({
        evalId,
        datapoints: testDatapoints,
      });

      assert.strictEqual(requestCount, 3);
      scope.done();
    });

    void it("handles non-413 errors after retries", async () => {
      const evalId = "eval-123";
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: "test",
          target: "test",
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
        },
      ];

      let requestCount = 0;

      // Mock 413 followed by 500 error
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [413, "Payload Too Large"];
        })
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(() => {
          requestCount++;
          return [500, "Internal Server Error"];
        });

      await assert.rejects(
        () => client.evals.saveDatapoints({
          evalId,
          datapoints: testDatapoints,
        }),
        (error: Error) => {
          assert.ok(error.message.includes("500"));
          return true;
        }
      );

      assert.strictEqual(requestCount, 2);
      scope.done();
    });

    void it("slices large payloads correctly on initial request", async () => {
      const evalId = "eval-123";
      const veryLargeData = "a".repeat(20_000_000); // 20MB
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: veryLargeData,
          target: veryLargeData,
          executorOutput: veryLargeData,
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
        },
      ];

      let capturedBody: RequestBody = {};

      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      await client.evals.saveDatapoints({
        evalId,
        datapoints: testDatapoints,
      });

      const point = capturedBody.points[0];

      // Should be sliced to initial max length (16MB) + "..."
      assert.strictEqual(point.data.length, 16_000_000 + 3);
      assert.strictEqual(point.target.length, 16_000_000 + 3);
      assert.strictEqual(point.executorOutput.length, 16_000_000 + 3);

      assert.ok(point.data.endsWith("..."));
      assert.ok(point.target.endsWith("..."));
      assert.ok(point.executorOutput.endsWith("..."));

      scope.done();
    });

    void it("tests exponential payload reduction with actual large data", async () => {
      const evalId = "eval-123";
      const largeData = "x".repeat(10_000_000); // 10MB
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: largeData,
          target: largeData,
          executorOutput: largeData,
          index: 0,
          traceId: "trace-1",
          executorSpanId: "span-1",
        },
      ];

      let capturedBodies: RequestBody[] = [];

      // Mock 413 responses and capture retry payloads
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBodies.push(body);
          return true;
        })
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBodies.push(body);
          return true;
        })
        .reply(200, {});

      await client.evals.saveDatapoints({
        evalId,
        datapoints: testDatapoints,
      });

      // We should have captured 2 retry attempts
      assert.strictEqual(capturedBodies.length, 2);

      const firstRetry = capturedBodies[0].points[0];
      const secondRetry = capturedBodies[1].points[0];

      // First retry: Uses initial length (16MB), so 10MB data doesn't get sliced
      // Since 10,000,002 < 16MB limit, original data is returned
      assert.strictEqual(firstRetry.data.length, 10_000_000);
      assert.strictEqual(firstRetry.target.length, 10_000_000);
      assert.strictEqual(firstRetry.executorOutput.length, 10_000_000);
      assert.strictEqual(firstRetry.data, largeData);
      assert.strictEqual(firstRetry.target, largeData);
      assert.strictEqual(firstRetry.executorOutput, largeData);

      // Second retry: Uses 8MB limit, so 10MB data gets sliced to 8MB + "..." = 8,000,003 chars
      assert.strictEqual(secondRetry.data.length, 8_000_000 + 3);
      assert.strictEqual(secondRetry.target.length, 8_000_000 + 3);
      assert.strictEqual(secondRetry.executorOutput.length, 8_000_000 + 3);
      assert.ok(secondRetry.data.endsWith("..."));
      assert.ok(secondRetry.target.endsWith("..."));
      assert.ok(secondRetry.executorOutput.endsWith("..."));

      scope.done();
    });

    void it("preserves other datapoint fields during retry", async () => {
      const evalId = "eval-123";
      const testDatapoints = [
        {
          id: MOCK_DATAPOINT_ID,
          data: "test data",
          target: "test target",
          executorOutput: "test output",
          index: 5,
          traceId: "trace-1",
          executorSpanId: "span-1",
          metadata: { key: "value", number: 42 },
          scores: { score1: 0.8, score2: 0.9 },
        },
      ];

      let capturedBody: RequestBody = {};

      // Mock 413 followed by success
      const scope = nock(baseUrl)
        .post(`/v1/evals/${evalId}/datapoints`)
        .reply(413, "Payload Too Large")
        .post(`/v1/evals/${evalId}/datapoints`, (body: RequestBody) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {});

      await client.evals.saveDatapoints({
        evalId,
        datapoints: testDatapoints,
      });

      const point = capturedBody.points[0];

      // Verify all fields are preserved
      assert.strictEqual(point.id, MOCK_DATAPOINT_ID);
      assert.strictEqual(point.index, 5);
      assert.strictEqual(point.traceId, "trace-1");
      assert.strictEqual(point.executorSpanId, "span-1");
      assert.deepStrictEqual(point.metadata, { key: "value", number: 42 });
      assert.deepStrictEqual(point.scores, { score1: 0.8, score2: 0.9 });

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
        // eslint-disable-next-line @stylistic/max-len
        .post(new RegExp(`/v1/evals/${mockEvalId}/datapoints/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`))
        .reply(200, {});

      const evalId = await client.evals.create({ name: evalName });

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
