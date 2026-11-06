import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { TagsResource } from "../src/resources/tags";

const TRACE_ID = "01234567-89ab-cdef-0123-456789abcdef";

void describe("Tags Resource Tests", () => {
  void it("apiKey auth → POST /v1/tag", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, json: () => ({}) }));
    global.fetch = mockFetch as any;

    const tags = new TagsResource("https://api.test.com:443", {
      type: "apiKey",
      key: "test-api-key",
    });
    await tags.tag(TRACE_ID, ["a", "b"]);

    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/tag",
    );
    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, "POST");
    assert.deepStrictEqual(JSON.parse(requestOptions.body as string), {
      traceId: TRACE_ID,
      names: ["a", "b"],
    });
  });

  void it("userToken auth → POST /v1/cli/tag with project header", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, json: () => ({}) }));
    global.fetch = mockFetch as any;

    const tags = new TagsResource("https://api.test.com:443", {
      type: "userToken",
      token: "jwt-abc",
      projectId: "proj-9",
    });
    await tags.tag(TRACE_ID, "single");

    const call = mockFetch.mock.calls[0];
    assert.strictEqual(
      (call.arguments as any)[0],
      "https://api.test.com:443/v1/cli/tag",
    );
    const requestOptions = (call.arguments as any)[1] as RequestInit;
    const headers = requestOptions.headers as Record<string, string>;
    assert.strictEqual(headers.Authorization, "Bearer jwt-abc");
    assert.strictEqual(headers["x-lmnr-project-id"], "proj-9");
    assert.deepStrictEqual(JSON.parse(requestOptions.body as string).names, [
      "single",
    ]);
  });
});
