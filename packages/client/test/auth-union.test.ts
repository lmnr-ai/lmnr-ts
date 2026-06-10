import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { LaminarClient } from "../src/index";

// Capture the URL + headers a resource emits so we can assert the prefix and
// the x-lmnr-project-id header are driven by the auth union (and by the legacy
// fields once normalized).
function captureFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const mockFetch = mock.fn((url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return { ok: true, json: () => Promise.resolve({ data: [] }) };
  });
  global.fetch = mockFetch as any;
  return calls;
}

void describe("LaminarClient unified auth", () => {
  void it("apiKey auth → /v1 prefix, no x-lmnr-project-id header", async () => {
    const calls = captureFetch();
    const client = new LaminarClient({
      baseUrl: "https://api.test.com",
      auth: { type: "apiKey", key: "pk-123" },
    });

    await client.sql.query("SELECT 1");

    assert.strictEqual(calls[0].url, "https://api.test.com:443/v1/sql/query");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer pk-123");
    assert.strictEqual(calls[0].headers["x-lmnr-project-id"], undefined);
  });

  void it("userToken auth → /v1/cli prefix + x-lmnr-project-id header", async () => {
    const calls = captureFetch();
    const client = new LaminarClient({
      baseUrl: "https://api.test.com",
      auth: { type: "userToken", token: "jwt-abc", projectId: "proj-9" },
    });

    await client.sql.query("SELECT 1");

    assert.strictEqual(calls[0].url, "https://api.test.com:443/v1/cli/sql/query");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer jwt-abc");
    assert.strictEqual(calls[0].headers["x-lmnr-project-id"], "proj-9");
  });

  void it("legacy projectApiKey normalizes to apiKey auth (/v1, no header)", async () => {
    const calls = captureFetch();
    const client = new LaminarClient({
      baseUrl: "https://api.test.com",
      projectApiKey: "legacy-key",
    });

    await client.sql.query("SELECT 1");

    assert.strictEqual(calls[0].url, "https://api.test.com:443/v1/sql/query");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer legacy-key");
    assert.strictEqual(calls[0].headers["x-lmnr-project-id"], undefined);
  });

  void it("legacy projectApiKey + cliUserProjectId normalizes to userToken auth", async () => {
    const calls = captureFetch();
    const client = new LaminarClient({
      baseUrl: "https://api.test.com",
      projectApiKey: "user-jwt",
      cliUserProjectId: "proj-legacy",
    });

    await client.sql.query("SELECT 1");

    assert.strictEqual(calls[0].url, "https://api.test.com:443/v1/cli/sql/query");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer user-jwt");
    assert.strictEqual(calls[0].headers["x-lmnr-project-id"], "proj-legacy");
  });

  void it("CliResource discovery uses bare /v1/cli/projects with no project header", async () => {
    const calls = captureFetch();
    const client = new LaminarClient({
      baseUrl: "https://api.test.com",
      auth: { type: "userToken", token: "jwt-disc", projectId: "" },
    });

    await client.cli.listProjects();

    assert.strictEqual(calls[0].url, "https://api.test.com:443/v1/cli/projects");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer jwt-disc");
    assert.strictEqual(calls[0].headers["x-lmnr-project-id"], undefined);
  });
});
