import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { HostedEvalsResource } from "../src/resources/hosted-evals";

const userToken = {
  type: "userToken" as const,
  token: "jwt",
  projectId: "proj-1",
};

void describe("HostedEvalsResource", () => {
  void it("uploads the archive as a raw gzip body", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => ({ uploadId: "up-1" }),
    }));
    global.fetch = mockFetch as any;

    const archive = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const result = await new HostedEvalsResource(
      "https://api.test.com:443",
      userToken,
    ).upload(archive);

    assert.deepStrictEqual(result, { uploadId: "up-1" });
    const [url, init] = mockFetch.mock.calls[0].arguments as any;
    assert.strictEqual(
      url,
      "https://api.test.com:443/v1/cli/hosted-evals/uploads",
    );
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(init.body, archive);
    assert.strictEqual(init.headers["Content-Type"], "application/gzip");
    assert.strictEqual(init.headers["x-lmnr-project-id"], "proj-1");
  });

  void it("starts a run with the options as JSON", async () => {
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => ({ sandboxId: "sb-1" }),
    }));
    global.fetch = mockFetch as any;

    const options = {
      uploadId: "up-1",
      cliVersion: "0.5.3",
      spec: { suites: ["hello"], env: { OPENAI_API_KEY: "sk" } },
    };
    const result = await new HostedEvalsResource("https://api.test.com:443", {
      type: "apiKey",
      key: "k",
    }).startRun(options);

    assert.deepStrictEqual(result, { sandboxId: "sb-1" });
    const [url, init] = mockFetch.mock.calls[0].arguments as any;
    assert.strictEqual(url, "https://api.test.com:443/v1/hosted-evals/runs");
    assert.strictEqual(init.headers["Content-Type"], "application/json");
    assert.deepStrictEqual(JSON.parse(init.body), options);
  });

  void it("surfaces the server's {error} message", async () => {
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 400,
      text: () => '{"error":"No archive uploaded for this uploadId"}',
    })) as any;

    await assert.rejects(
      new HostedEvalsResource("https://api.test.com:443", userToken).startRun({
        uploadId: "nope",
        cliVersion: "0.5.3",
        spec: {},
      }),
      { message: "400 No archive uploaded for this uploadId" },
    );
  });

  void it("pushes an image: missing layers, a streamed layer, the config", async () => {
    const responses: Record<string, unknown> = {
      "/images/layers/missing": { missing: ["sha256:aa"] },
      "/images/layers/sha256:aa": { digest: "sha256:bb", size: 3 },
      "/images": { image: "sha256:cc" },
    };
    const mockFetch = mock.fn((url: string) => ({
      ok: true,
      json: () => responses[url.split("/hosted-evals")[1] ?? ""],
    }));
    global.fetch = mockFetch as any;
    const resource = new HostedEvalsResource(
      "https://api.test.com:443",
      userToken,
    );

    assert.deepStrictEqual(
      await resource.missingLayers(["sha256:aa", "sha256:dd"]),
      ["sha256:aa"],
    );
    const layer = new ReadableStream<Uint8Array>();
    assert.deepStrictEqual(await resource.uploadLayer("sha256:aa", layer), {
      digest: "sha256:bb",
      size: 3,
    });
    const config = '{"architecture":"amd64"}';
    assert.deepStrictEqual(await resource.createImage(config), {
      image: "sha256:cc",
    });

    const calls = mockFetch.mock.calls.map((c) => c.arguments as any);
    assert.strictEqual(
      calls[0][0],
      "https://api.test.com:443/v1/cli/hosted-evals/images/layers/missing",
    );
    assert.deepStrictEqual(JSON.parse(calls[0][1].body), {
      diffIds: ["sha256:aa", "sha256:dd"],
    });
    assert.strictEqual(calls[1][1].method, "PUT");
    assert.strictEqual(calls[1][1].body, layer);
    assert.strictEqual(calls[1][1].duplex, "half");
    assert.strictEqual(calls[1][1].headers["Content-Type"], "application/gzip");
    assert.deepStrictEqual(JSON.parse(calls[2][1].body), { config });
  });
});
