import assert from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import nock from "nock";

import { LaminarClient } from "../src/index";

void describe("TracesResource Client Methods", () => {
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

  void describe("mergeMetadata", () => {
    void it("POSTs to /v1/traces/metadata with the formatted UUID", async () => {
      const traceId = "12345678-1234-5678-9abc-123456789abc";
      const metadata = { score: 0.85, reviewer: "alice" };

      const scope = nock(baseUrl)
        .post("/v1/traces/metadata", { traceId, metadata })
        .reply(200);

      await client.traces.mergeMetadata(traceId, metadata);
      scope.done();
    });

    void it("accepts an OTel hex trace id and converts it to a UUID", async () => {
      // 32 lowercase hex chars; matches an OTel TraceId.
      const otelHex = "12345678123456789abc123456789abc";
      const expectedUuid = "12345678-1234-5678-9abc-123456789abc";

      const scope = nock(baseUrl)
        .post("/v1/traces/metadata", { traceId: expectedUuid, metadata: { k: "v" } })
        .reply(200);

      await client.traces.mergeMetadata(otelHex, { k: "v" });
      scope.done();
    });

    void it("silently swallows 404 (trace not flushed yet)", async () => {
      const traceId = "12345678-1234-5678-9abc-123456789abc";
      const scope = nock(baseUrl)
        .post("/v1/traces/metadata")
        .reply(404, "Trace not found");

      // No throw — that's the contract.
      await client.traces.mergeMetadata(traceId, { k: "v" });
      scope.done();
    });

    void it("throws on non-OK statuses other than 404", async () => {
      const traceId = "12345678-1234-5678-9abc-123456789abc";
      const scope = nock(baseUrl)
        .post("/v1/traces/metadata")
        .reply(500, "Internal");

      await assert.rejects(
        () => client.traces.mergeMetadata(traceId, { k: "v" }),
        /500/,
      );
      scope.done();
    });

    void it("throws synchronously on empty metadata", async () => {
      const traceId = "12345678-1234-5678-9abc-123456789abc";
      // No nock interceptor — the call must short-circuit before fetch.
      await assert.rejects(
        () => client.traces.mergeMetadata(traceId, {}),
        /non-empty/,
      );
    });
  });
});
