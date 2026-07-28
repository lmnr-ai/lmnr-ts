import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { RolloutSessionsResource } from "../src/resources/rollout-sessions";

void describe("RolloutSessions Resource Tests", () => {
  void it("should POST to the rollouts endpoint with the session id", async () => {
    const mockFetch = mock.fn(() => ({ ok: true }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    await resource.register({ sessionId: "sess-1" });

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/rollouts/sess-1",
    );

    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, "POST");
    const body = JSON.parse(requestOptions.body as string);
    assert.strictEqual(body.name, undefined);
  });

  void it("should return the backend-resolved projectId", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ projectId: "proj-123" }),
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const projectId = await resource.register({ sessionId: "sess-1" });

    assert.strictEqual(projectId, "proj-123");
  });

  void it("should return null when the body cannot be parsed", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.reject(new Error("not json")),
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const projectId = await resource.register({ sessionId: "sess-1" });

    assert.strictEqual(projectId, null);
  });

  void it("should pass an optional name in the body", async () => {
    const mockFetch = mock.fn(() => ({ ok: true }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    await resource.register({ sessionId: "sess-2", name: "my run" });

    const requestOptions = (
      mockFetch.mock.calls[0].arguments as any
    )[1] as RequestInit;
    const body = JSON.parse(requestOptions.body as string);
    assert.strictEqual(body.name, "my run");
  });

  void it("should DELETE the rollouts endpoint", async () => {
    const mockFetch = mock.fn(() => ({ ok: true }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    await resource.delete({ sessionId: "sess-3" });

    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/rollouts/sess-3",
    );
    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, "DELETE");
  });

  void it("should throw on a non-ok response", async () => {
    const mockFetch = mock.fn(() => ({
      ok: false,
      status: 500,
      text: () => "boom",
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    await assert.rejects(
      () => resource.register({ sessionId: "sess-4" }),
      /500/,
    );
  });

  void it("addBlock POSTs {type, content} to the blocks endpoint", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ id: "block-1" }),
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const id = await resource.addBlock({
      sessionId: "sess-5",
      type: "text",
      content: { text: "a note" },
    });

    assert.strictEqual(id, "block-1");
    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/rollouts/sess-5/blocks",
    );
    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, "POST");
    const body = JSON.parse(requestOptions.body as string);
    assert.deepStrictEqual(body, { type: "text", content: { text: "a note" } });
  });

  void it("addBlock POSTs a `command` block (new block type)", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ id: "block-2" }),
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const id = await resource.addBlock({
      sessionId: "sess-cmd",
      type: "command",
      content: { command: "sql query", args: ["SELECT 1"], exitCode: 0 },
    });

    assert.strictEqual(id, "block-2");
    const requestOptions = (mockFetch.mock.calls[0].arguments as any)[1] as RequestInit;
    const body = JSON.parse(requestOptions.body as string);
    assert.deepStrictEqual(body, {
      type: "command",
      content: { command: "sql query", args: ["SELECT 1"], exitCode: 0 },
    });
  });

  void it("addBlock returns null and warns on 404 by default", async () => {
    const mockFetch = mock.fn(() => ({ ok: false, status: 404, text: () => "nope" }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const id = await resource.addBlock({
      sessionId: "sess-6",
      type: "text",
      content: { text: "x" },
    });

    assert.strictEqual(id, null);
  });

  void it("addBlock throws on 404 when failOnNotFound is set", async () => {
    const mockFetch = mock.fn(() => ({ ok: false, status: 404, text: () => "nope" }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    await assert.rejects(
      () =>
        resource.addBlock({
          sessionId: "sess-7",
          type: "text",
          content: { text: "x" },
          failOnNotFound: true,
        }),
      /Could not add a note: HTTP 404/,
    );
  });

  void it("listBlocks GETs the blocks endpoint and unwraps {blocks}", async () => {
    const blocks = [
      {
        id: "b1",
        createdAt: "2026-06-01T10:00:00.000Z",
        type: "trace",
        content: { traceId: "t1" },
      },
      { id: "b2", createdAt: "2026-06-01T11:00:00.000Z", type: "text", content: { text: "hi" } },
    ];
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ blocks }),
    }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const result = await resource.listBlocks({ sessionId: "sess-8" });

    assert.deepStrictEqual(result, blocks);
    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/rollouts/sess-8/blocks",
    );
    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, "GET");
  });

  void it("listBlocks accepts a bare array body", async () => {
    const blocks = [
      { id: "b1", createdAt: "2026-06-01T10:00:00.000Z", type: "text", content: { text: "hi" } },
    ];
    const mockFetch = mock.fn(() => ({ ok: true, json: () => Promise.resolve(blocks) }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      { type: "apiKey", key: "test-api-key" },
    );
    const result = await resource.listBlocks({ sessionId: "sess-9" });

    assert.deepStrictEqual(result, blocks);
  });
});
