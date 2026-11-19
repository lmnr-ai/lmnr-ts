import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { EvalDatasetsResource } from "../src/resources/eval-datasets";
import { LaminarApiError } from "../src/resources/index";

const BASE = "https://api.test.com:443";
const HASH = "a".repeat(64);
const userToken = {
  type: "userToken" as const,
  token: "jwt",
  projectId: "proj-1",
};
const apiKey = { type: "apiKey" as const, key: "k" };

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  json: () => body,
  text: () => JSON.stringify(body),
});

void describe("EvalDatasetsResource", () => {
  void it("gets a dataset, and null for dataset_not_found", async () => {
    const dataset = {
      id: "support",
      createdAt: "2026-11-01T00:00:00Z",
      tasks: [{ id: "refund", hash: HASH, createdAt: "2026-11-01T00:00:00Z" }],
    };
    const mockFetch = mock.fn(() => jsonResponse(200, dataset));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(BASE, userToken);

    assert.deepStrictEqual(await resource.get("support"), dataset);
    const [url, init] = mockFetch.mock.calls[0].arguments as any;
    assert.strictEqual(url, `${BASE}/v1/cli/eval-datasets/support`);
    assert.strictEqual(init.headers["x-lmnr-project-id"], "proj-1");

    global.fetch = mock.fn(() =>
      jsonResponse(404, {
        error: "Dataset not found",
        code: "dataset_not_found",
      }),
    ) as any;
    assert.strictEqual(await resource.get("support"), null);
  });

  void it("throws errors with the server's code", async () => {
    global.fetch = mock.fn(() =>
      jsonResponse(501, {
        error: "Storage is not configured",
        code: "storage_not_configured",
      }),
    ) as any;
    const resource = new EvalDatasetsResource(BASE, apiKey);

    await assert.rejects(resource.get("support"), (error: unknown) => {
      assert.ok(error instanceof LaminarApiError);
      assert.strictEqual(error.status, 501);
      assert.strictEqual(error.code, "storage_not_configured");
      assert.strictEqual(error.message, "501 Storage is not configured");
      return true;
    });

    // A 404 without a code (e.g. a server without the route) is an error.
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => "",
    })) as any;
    await assert.rejects(resource.get("support"), (error: unknown) => {
      assert.ok(error instanceof LaminarApiError);
      assert.strictEqual(error.code, undefined);
      assert.strictEqual(error.message, "404 Not Found");
      return true;
    });
  });

  void it("asks for missing versions in batches of 10000", async () => {
    const mockFetch = mock.fn((_url: string, init: any) => {
      const { versions } = JSON.parse(init.body);
      return jsonResponse(200, { missing: versions.slice(0, 1) });
    });
    global.fetch = mockFetch as any;
    const versions = Array.from({ length: 10_001 }, (_, i) => ({
      task: `t${i}`,
      hash: HASH,
    }));

    const missing = await new EvalDatasetsResource(
      BASE,
      apiKey,
    ).missingVersions("support", versions);

    assert.deepStrictEqual(missing, [
      { task: "t0", hash: HASH },
      { task: "t10000", hash: HASH },
    ]);
    assert.strictEqual(mockFetch.mock.calls.length, 2);
    const [url, init] = mockFetch.mock.calls[0].arguments as any;
    assert.strictEqual(
      url,
      `${BASE}/v1/eval-datasets/support/versions/missing`,
    );
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(JSON.parse(init.body).versions.length, 10_000);
  });

  void it("uploads a version archive, then its index", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, status: 204 }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(BASE, userToken);
    const archive = new Uint8Array([0x1f, 0x8b, 1]);

    await resource.uploadVersion("support", "refund.v2", HASH, archive);
    await resource.uploadVersionIndex("support", "refund.v2", HASH, {
      files: [],
    });

    const calls = mockFetch.mock.calls.map((c) => c.arguments as any);
    const versionUrl = `${BASE}/v1/cli/eval-datasets/support/tasks/refund.v2/versions/${HASH}`;
    assert.strictEqual(calls[0][0], versionUrl);
    assert.strictEqual(calls[0][1].method, "PUT");
    assert.strictEqual(calls[0][1].body, archive);
    assert.strictEqual(calls[0][1].headers["Content-Type"], "application/gzip");
    assert.strictEqual(calls[0][1].duplex, undefined);
    assert.strictEqual(calls[1][0], `${versionUrl}/index`);
    assert.deepStrictEqual(JSON.parse(calls[1][1].body), { files: [] });

    // A streamed archive needs `duplex: "half"`.
    const stream = new ReadableStream<Uint8Array>();
    await resource.uploadVersion("support", "refund", HASH, stream);
    assert.strictEqual(
      (mockFetch.mock.calls[2].arguments as any)[1].duplex,
      "half",
    );
  });

  void it("downloads a version as a stream; version_not_found throws", async () => {
    const body = new ReadableStream<Uint8Array>();
    const mockFetch = mock.fn(() => ({ ok: true, status: 200, body }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(BASE, apiKey);

    assert.strictEqual(
      await resource.downloadVersion("support", "refund", HASH),
      body,
    );
    assert.strictEqual(
      (mockFetch.mock.calls[0].arguments as any)[0],
      `${BASE}/v1/eval-datasets/support/tasks/refund/versions/${HASH}`,
    );

    global.fetch = mock.fn(() =>
      jsonResponse(404, {
        error: "No such version",
        code: "version_not_found",
      }),
    ) as any;
    await assert.rejects(resource.downloadVersion("support", "refund", HASH), {
      code: "version_not_found",
    });
  });

  void it("returns a push's result or its 409 conflict", async () => {
    const pushed = [{ id: "refund", hash: HASH, createdAt: "now" }];
    const mockFetch = mock.fn(() => jsonResponse(200, { tasks: pushed }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(BASE, apiKey);
    const tasks = [{ task: "refund", hash: HASH, base: null }];

    assert.deepStrictEqual(await resource.push("support", tasks), {
      status: "pushed",
      tasks: pushed,
    });
    const [url, init] = mockFetch.mock.calls[0].arguments as any;
    assert.strictEqual(url, `${BASE}/v1/eval-datasets/support/push`);
    assert.deepStrictEqual(JSON.parse(init.body), { tasks });

    const moved = [{ task: "refund", latest: "b".repeat(64) }];
    global.fetch = mock.fn(() =>
      jsonResponse(409, { error: "Moved", code: "moved", moved }),
    ) as any;
    assert.deepStrictEqual(await resource.push("support", tasks), {
      status: "moved",
      moved,
    });

    const missing = [{ task: "refund", hash: HASH }];
    global.fetch = mock.fn(() =>
      jsonResponse(409, {
        error: "Missing",
        code: "versions_missing",
        missing,
      }),
    ) as any;
    assert.deepStrictEqual(await resource.push("support", tasks), {
      status: "versions_missing",
      missing,
    });

    global.fetch = mock.fn(() =>
      jsonResponse(400, { error: "Empty push", code: "invalid_request" }),
    ) as any;
    await assert.rejects(resource.push("support", []), {
      message: "400 Empty push",
    });
  });
});
