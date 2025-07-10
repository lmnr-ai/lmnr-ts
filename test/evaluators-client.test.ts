import assert from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import nock from "nock";

import { LaminarClient } from "../src";
import { StringUUID } from "../src/utils";

type RequestBody = Record<string, any>;

void describe("EvaluatorsResource Client Methods", () => {
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

  void describe("score", () => {
    void describe("with traceId", () => {
      void it("creates a score with UUID format traceId", async () => {
        const testTraceId: StringUUID = "12345678-1234-1234-1234-123456789abc";
        const testName = "quality";
        const testScore = 0.95;
        const testMetadata = { model: "gpt-4", version: "1.0" };

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          traceId: testTraceId,
          score: testScore,
          metadata: testMetadata,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.traceId, testTraceId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.deepStrictEqual(capturedBody.metadata, testMetadata);
        assert.strictEqual(capturedBody.source, "SDK");
        assert.strictEqual(capturedBody.spanId, undefined);

        scope.done();
      });

      void it("creates a score with OTEL format traceId", async () => {
        const testOtelTraceId = "1234567890abcdef1234567890abcdef";
        const expectedUuidTraceId = "12345678-90ab-cdef-1234-567890abcdef";
        const testName = "relevance";
        const testScore = 0.87;

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          traceId: testOtelTraceId,
          score: testScore,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.traceId, expectedUuidTraceId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.strictEqual(capturedBody.metadata, undefined);
        assert.strictEqual(capturedBody.source, "SDK");
        assert.strictEqual(capturedBody.spanId, undefined);

        scope.done();
      });

      void it("creates a score with OTEL format traceId with 0x prefix", async () => {
        const testOtelTraceId = "0x1234567890abcdef1234567890abcdef";
        const expectedUuidTraceId = "12345678-90ab-cdef-1234-567890abcdef";
        const testName = "accuracy";
        const testScore = 1.0;

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          traceId: testOtelTraceId,
          score: testScore,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.traceId, expectedUuidTraceId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.strictEqual(capturedBody.source, "SDK");

        scope.done();
      });
    });

    void describe("with spanId", () => {
      void it("creates a score with UUID format spanId", async () => {
        const testSpanId: StringUUID = "87654321-4321-4321-4321-ba0987654321";
        const testName = "helpfulness";
        const testScore = 0.92;
        const testMetadata = { assistant: "claude", temperature: 0.7 };

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          spanId: testSpanId,
          score: testScore,
          metadata: testMetadata,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.spanId, testSpanId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.deepStrictEqual(capturedBody.metadata, testMetadata);
        assert.strictEqual(capturedBody.source, "SDK");
        assert.strictEqual(capturedBody.traceId, undefined);

        scope.done();
      });

      void it("creates a score with OTEL format spanId", async () => {
        const testOtelSpanId = "fedcba0987654321";
        const expectedUuidSpanId = "00000000-0000-0000-fedc-ba0987654321";
        const testName = "safety";
        const testScore = 0.98;

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          spanId: testOtelSpanId,
          score: testScore,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.spanId, expectedUuidSpanId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.strictEqual(capturedBody.metadata, undefined);
        assert.strictEqual(capturedBody.source, "SDK");
        assert.strictEqual(capturedBody.traceId, undefined);

        scope.done();
      });

      void it("creates a score with OTEL format spanId with 0x prefix", async () => {
        const testOtelSpanId = "0xfedcba0987654321";
        const expectedUuidSpanId = "00000000-0000-0000-fedc-ba0987654321";
        const testName = "coherence";
        const testScore = 0.88;

        let capturedBody: RequestBody = {};

        const scope = nock(baseUrl)
          .post("/v1/evaluators/score", (body: RequestBody) => {
            capturedBody = body;
            return true;
          })
          .reply(200, {});

        await client.evaluators.score({
          name: testName,
          spanId: testOtelSpanId,
          score: testScore,
        });

        // Verify the request body
        assert.strictEqual(capturedBody.name, testName);
        assert.strictEqual(capturedBody.spanId, expectedUuidSpanId);
        assert.strictEqual(capturedBody.score, testScore);
        assert.strictEqual(capturedBody.source, "SDK");

        scope.done();
      });
    });

    void describe("error handling", () => {
      void it("throws error when neither traceId nor spanId is provided", async () => {
        await assert.rejects(
          () => client.evaluators.score({
            name: "test",
            score: 0.5,
          } as any),
          (error: Error) => {
            assert.strictEqual(error.message, "Either 'traceId' or 'spanId' must be provided.");
            return true;
          },
        );
      });
    });
  });
});