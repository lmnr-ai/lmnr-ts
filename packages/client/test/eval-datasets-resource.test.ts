import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import {
  EvalDatasetsError,
  EvalDatasetsResource,
} from "../src/resources/eval-datasets";

const HASH = "a".repeat(64);
const BASE = "https://api.test.com:443";

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

    await new EvalDatasetsResource(BASE, userToken).list();
    await new EvalDatasetsResource(BASE, apiKey).list();

    const [[cliUrl, cliInit], [keyUrl, keyInit]] = calls(mockFetch);
    assert.strictEqual(cliUrl, `${BASE}/v1/cli/eval-datasets`);
    assert.strictEqual(cliInit.headers["x-lmnr-project-id"], "proj-1");
    assert.strictEqual(cliInit.headers.Authorization, "Bearer jwt");
    assert.strictEqual(keyUrl, `${BASE}/v1/eval-datasets`);
    assert.strictEqual(keyInit.headers["x-lmnr-project-id"], undefined);
    assert.strictEqual(keyInit.headers.Authorization, "Bearer k");
  });

  void it("lists a dataset's latest task versions", async () => {
    const tasks = [{ name: "refund", hash: HASH, createdAt: "2026-11-18" }];
    const mockFetch = mock.fn(() => ({ ok: true, json: () => ({ tasks }) }));
    global.fetch = mockFetch as any;

    assert.deepStrictEqual(
      await new EvalDatasetsResource(BASE, apiKey).listTasks("my.set"),
      tasks,
    );
    const [[url, init]] = calls(mockFetch);
    assert.strictEqual(url, `${BASE}/v1/eval-datasets/my.set/tasks`);
    assert.strictEqual(init.method, undefined);
  });

  void it("pushes: missing versions, the raw archive, its index, then latest", async () => {
    const pushed = [{ name: "refund", hash: HASH, createdAt: "2026-11-18" }];
    const mockFetch = mock.fn((url: string, init?: RequestInit) => ({
      ok: true,
      json: () =>
        url.endsWith("/missing")
          ? { missing: ["refund"] }
          : init?.method === "POST"
            ? { tasks: pushed }
            : undefined,
    }));
    global.fetch = mockFetch as any;
    const resource = new EvalDatasetsResource(BASE, apiKey);

    assert.deepStrictEqual(
      await resource.missingTasks("support", { refund: HASH }),
      ["refund"],
    );
    const archive = new Uint8Array([0x1f, 0x8b, 1]);
    await resource.uploadTask("support", "refund", HASH, archive);
    const index = { files: [{ path: "task.toml" }] };
    await resource.uploadTaskIndex("support", "refund", HASH, index);
    assert.deepStrictEqual(
      await resource.pushTasks("support", { refund: HASH }),
      pushed,
    );

    const [missing, upload, uploadIndex, push] = calls(mockFetch);
    assert.strictEqual(
      missing[0],
      `${BASE}/v1/eval-datasets/support/tasks/missing`,
    );
    assert.strictEqual(missing[1].method, "POST");
    assert.deepStrictEqual(JSON.parse(missing[1].body), {
      tasks: { refund: HASH },
    });
    const version = `${BASE}/v1/eval-datasets/support/tasks/refund/versions/${HASH}`;
    assert.strictEqual(upload[0], version);
    assert.strictEqual(upload[1].method, "PUT");
    assert.strictEqual(upload[1].body, archive);
    assert.strictEqual(upload[1].headers["Content-Type"], "application/gzip");
    assert.strictEqual(uploadIndex[0], `${version}/index`);
    assert.strictEqual(uploadIndex[1].method, "PUT");
    assert.deepStrictEqual(JSON.parse(uploadIndex[1].body), index);
    assert.strictEqual(push[0], `${BASE}/v1/eval-datasets/support/tasks`);
    assert.strictEqual(push[1].method, "POST");
    assert.deepStrictEqual(JSON.parse(push[1].body), {
      tasks: { refund: HASH },
    });
  });

  void it("streams a task version's archive", async () => {
    const body = new ReadableStream<Uint8Array>();
    const mockFetch = mock.fn(() => ({ ok: true, body }));
    global.fetch = mockFetch as any;

    const stream = await new EvalDatasetsResource(BASE, userToken).downloadTask(
      "support",
      "refund",
      HASH,
    );

    assert.strictEqual(stream, body);
    const [[url, init]] = calls(mockFetch);
    assert.strictEqual(
      url,
      `${BASE}/v1/cli/eval-datasets/support/tasks/refund/versions/${HASH}`,
    );
    assert.strictEqual(init.method, undefined);
    assert.strictEqual(init.headers.Accept, "application/gzip");
  });

  void it("raises the server's error with its status and missing tasks", async () => {
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 409,
      text: () =>
        JSON.stringify({ error: "Tasks not uploaded", missing: ["refund"] }),
    })) as any;
    const resource = new EvalDatasetsResource(BASE, apiKey);

    await assert.rejects(
      resource.pushTasks("support", { refund: HASH }),
      (error: unknown) => {
        assert.ok(error instanceof EvalDatasetsError);
        assert.strictEqual(error.message, "409 Tasks not uploaded");
        assert.strictEqual(error.status, 409);
        assert.deepStrictEqual(error.missing, ["refund"]);
        return true;
      },
    );

    global.fetch = mock.fn(() => ({
      ok: false,
      status: 502,
      text: () => "Bad Gateway",
    })) as any;
    await assert.rejects(resource.listTasks("support"), {
      message: "502 Bad Gateway",
      status: 502,
    });
  });
});
