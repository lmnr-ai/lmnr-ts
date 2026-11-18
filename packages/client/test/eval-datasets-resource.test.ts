import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import {
  EvalDatasetsError,
  EvalDatasetsResource,
} from "../src/resources/eval-datasets";

const HASH = `sha256:${"a".repeat(64)}`;

const userToken = {
  type: "userToken" as const,
  token: "jwt",
  projectId: "proj-1",
};
const apiKey = { type: "apiKey" as const, key: "k" };

const calls = (mockFetch: ReturnType<typeof mock.fn>) =>
  mockFetch.mock.calls.map((c) => c.arguments as any);

void describe("EvalDatasetsResource", () => {
  void it("routes to /v1/cli with a user token and /v1 with a project key", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, json: () => [] }));
    global.fetch = mockFetch as any;

    await new EvalDatasetsResource(
      "https://api.test.com:443",
      userToken,
    ).list();
    await new EvalDatasetsResource("https://api.test.com:443", apiKey).list();

    const [[cliUrl, cliInit], [keyUrl, keyInit]] = calls(mockFetch);
    assert.strictEqual(cliUrl, "https://api.test.com:443/v1/cli/eval-datasets");
    assert.strictEqual(cliInit.headers["x-lmnr-project-id"], "proj-1");
    assert.strictEqual(cliInit.headers.Authorization, "Bearer jwt");
    assert.strictEqual(keyUrl, "https://api.test.com:443/v1/eval-datasets");
    assert.strictEqual(keyInit.headers["x-lmnr-project-id"], undefined);
    assert.strictEqual(keyInit.headers.Authorization, "Bearer k");
  });

  void it("uploads a task: missing hashes, the raw archive, its index", async () => {
    const mockFetch = mock.fn((url: string) => ({
      ok: true,
      json: () => (url.endsWith("/missing") ? { missing: [HASH] } : undefined),
    }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(
      "https://api.test.com:443",
      apiKey,
    );

    assert.deepStrictEqual(await resource.missingTasks([HASH]), [HASH]);
    const archive = new Uint8Array([0x1f, 0x8b, 1]);
    await resource.uploadTask(HASH, archive);
    const index = { files: [{ path: "task.toml" }] };
    await resource.uploadTaskIndex(HASH, index);

    const [missing, upload, uploadIndex] = calls(mockFetch);
    assert.strictEqual(
      missing[0],
      "https://api.test.com:443/v1/eval-dataset-tasks/missing",
    );
    assert.strictEqual(missing[1].method, "POST");
    assert.deepStrictEqual(JSON.parse(missing[1].body), { hashes: [HASH] });
    assert.strictEqual(
      upload[0],
      `https://api.test.com:443/v1/eval-dataset-tasks/${encodeURIComponent(HASH)}`,
    );
    assert.strictEqual(upload[1].method, "PUT");
    assert.strictEqual(upload[1].body, archive);
    assert.strictEqual(upload[1].headers["Content-Type"], "application/gzip");
    assert.strictEqual(
      uploadIndex[0],
      `https://api.test.com:443/v1/eval-dataset-tasks/${encodeURIComponent(HASH)}/index`,
    );
    assert.strictEqual(uploadIndex[1].method, "PUT");
    assert.deepStrictEqual(JSON.parse(uploadIndex[1].body), index);
  });

  void it("streams a task's archive", async () => {
    const body = new ReadableStream<Uint8Array>();
    const mockFetch = mock.fn(() => ({ ok: true, body }));
    global.fetch = mockFetch as any;

    const stream = await new EvalDatasetsResource(
      "https://api.test.com:443",
      userToken,
    ).downloadTask(HASH);

    assert.strictEqual(stream, body);
    const [[url, init]] = calls(mockFetch);
    assert.strictEqual(
      url,
      `https://api.test.com:443/v1/cli/eval-dataset-tasks/${encodeURIComponent(HASH)}`,
    );
    assert.strictEqual(init.method, undefined);
  });

  void it("gets a version by number or latest, and creates one", async () => {
    const version = {
      datasetId: "d-1",
      dataset: "support",
      version: 3,
      parentVersion: 2,
      message: null,
      createdAt: "2026-11-18T00:00:00Z",
      tasks: { refund: HASH },
    };
    const created = {
      datasetId: "d-1",
      dataset: "support",
      version: 4,
      previousLatest: 3,
    };
    const mockFetch = mock.fn((_url: string, init?: RequestInit) => ({
      ok: true,
      json: () => (init?.method === "POST" ? created : version),
    }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(
      "https://api.test.com:443",
      userToken,
    );

    assert.deepStrictEqual(await resource.getVersion("support", 3), version);
    await resource.getVersion("my.set", "latest");
    const options = {
      parentVersion: 3,
      message: "fix refund",
      tasks: { refund: HASH },
    };
    assert.deepStrictEqual(
      await resource.createVersion("support", options),
      created,
    );

    const [v3, latest, create] = calls(mockFetch);
    assert.strictEqual(
      v3[0],
      "https://api.test.com:443/v1/cli/eval-datasets/support/versions/3",
    );
    assert.strictEqual(
      latest[0],
      "https://api.test.com:443/v1/cli/eval-datasets/my.set/versions/latest",
    );
    assert.strictEqual(
      create[0],
      "https://api.test.com:443/v1/cli/eval-datasets/support/versions",
    );
    assert.strictEqual(create[1].method, "POST");
    assert.deepStrictEqual(JSON.parse(create[1].body), options);
  });

  void it("raises the server's error with its status and missing hashes", async () => {
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 409,
      text: () =>
        JSON.stringify({ error: "Tasks not uploaded", missing: [HASH] }),
    })) as any;
    const resource = new EvalDatasetsResource(
      "https://api.test.com:443",
      apiKey,
    );

    await assert.rejects(
      resource.createVersion("support", { tasks: { refund: HASH } }),
      (error: unknown) => {
        assert.ok(error instanceof EvalDatasetsError);
        assert.strictEqual(error.message, "409 Tasks not uploaded");
        assert.strictEqual(error.status, 409);
        assert.deepStrictEqual(error.missing, [HASH]);
        return true;
      },
    );

    global.fetch = mock.fn(() => ({
      ok: false,
      status: 502,
      text: () => "Bad Gateway",
    })) as any;
    await assert.rejects(resource.getVersion("support", "latest"), {
      message: "502 Bad Gateway",
      status: 502,
    });
  });
});
