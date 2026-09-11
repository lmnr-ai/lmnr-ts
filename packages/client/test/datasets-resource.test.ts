import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { DatasetsResource } from "../src/resources/datasets";

const datasetId = "11111111-1111-1111-1111-111111111111";
const dataset = { id: datasetId, name: "examples", createdAt: "2026-01-01T00:00:00Z" };

const resource = () => new DatasetsResource(
  "https://api.test.com",
  { type: "userToken", token: "token", projectId: "project" },
);

void describe("DatasetsResource CRUD", () => {
  void it("creates an empty dataset", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve(dataset),
    }));
    global.fetch = mockFetch as any;

    assert.deepStrictEqual(await resource().create("examples"), dataset);
    const [url, options] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(url, "https://api.test.com/v1/cli/datasets");
    assert.strictEqual(options.method, "POST");
    assert.deepStrictEqual(JSON.parse(options.body as string), { name: "examples" });
  });

  void it("gets a dataset by id", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve(dataset),
    }));
    global.fetch = mockFetch as any;

    assert.deepStrictEqual(await resource().getById(datasetId), dataset);
    const [url, options] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(url, `https://api.test.com/v1/cli/datasets/${datasetId}`);
    assert.strictEqual(options.method, "GET");
  });

  void it("updates a dataset by id", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ ...dataset, name: "renamed" }),
    }));
    global.fetch = mockFetch as any;

    await resource().update(datasetId, "renamed");
    const [url, options] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(url, `https://api.test.com/v1/cli/datasets/${datasetId}`);
    assert.strictEqual(options.method, "PATCH");
    assert.deepStrictEqual(JSON.parse(options.body as string), { name: "renamed" });
  });

  void it("deletes a dataset by id", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve(dataset),
    }));
    global.fetch = mockFetch as any;

    assert.deepStrictEqual(await resource().delete(datasetId), dataset);
    const [url, options] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(url, `https://api.test.com/v1/cli/datasets/${datasetId}`);
    assert.strictEqual(options.method, "DELETE");
  });

  void it("surfaces CRUD API errors", async () => {
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"error":"Dataset not found"}'),
    })) as any;

    await assert.rejects(resource().getById(datasetId), /404.*Dataset not found/);
  });
});
