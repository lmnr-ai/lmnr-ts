import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { RolloutSessionsResource } from "../src/resources/rollout-sessions";

void describe("RolloutSessions Resource Tests", () => {
  void it("should POST to the rollouts endpoint with the session id", async () => {
    const mockFetch = mock.fn(() => ({ ok: true }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      "test-api-key",
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
      "test-api-key",
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
      "test-api-key",
    );
    const projectId = await resource.register({ sessionId: "sess-1" });

    assert.strictEqual(projectId, null);
  });

  void it("should pass an optional name in the body", async () => {
    const mockFetch = mock.fn(() => ({ ok: true }));
    global.fetch = mockFetch as any;

    const resource = new RolloutSessionsResource(
      "https://api.test.com:443",
      "test-api-key",
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
      "test-api-key",
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
      "test-api-key",
    );
    await assert.rejects(
      () => resource.register({ sessionId: "sess-4" }),
      /500/,
    );
  });
});
