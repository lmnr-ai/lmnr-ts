import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { gunzipSync, gzipSync } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gzippedLayer, readSavedImage, uploadSavedImage } from "./push";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-push-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const diffA = `sha256:${"a".repeat(64)}`;
const diffB = `sha256:${"b".repeat(64)}`;

/** A `docker save` folder: one uncompressed layer, one gzip layer, repeated. */
const writeSavedImage = async (architecture = "amd64") => {
  const config = JSON.stringify({
    architecture,
    rootfs: { type: "layers", diff_ids: [diffA, diffB, diffA] },
  });
  await mkdir(path.join(root, "blobs/sha256"), { recursive: true });
  await writeFile(path.join(root, "blobs/sha256/config"), config);
  await writeFile(path.join(root, "blobs/sha256/a"), "plain layer tar");
  await writeFile(path.join(root, "blobs/sha256/b"), gzipSync("gzip layer"));
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify([
      {
        Config: "blobs/sha256/config",
        Layers: ["blobs/sha256/a", "blobs/sha256/b", "blobs/sha256/a"],
      },
    ]),
  );
  return config;
};

const fakeClient = (missing: string[]) => {
  const uploads: { diffId: string; body: Buffer }[] = [];
  const configs: string[] = [];
  const client = {
    hostedEvals: {
      missingLayers: async () => missing,
      uploadLayer: async (diffId: string, body: ReadableStream<Uint8Array>) => {
        uploads.push({ diffId, body: await buffer(body) });
        return { digest: "sha256:x", size: 1 };
      },
      createImage: async (config: string) => {
        configs.push(config);
        return { image: `sha256:${"c".repeat(64)}` };
      },
    },
  } as unknown as LaminarClient;
  return { client, uploads, configs };
};

void describe("push", () => {
  void it("reads a docker save folder", async () => {
    const config = await writeSavedImage();
    const image = await readSavedImage(root);
    expect(image.config).toBe(config);
    expect(image.diffIds).toEqual([diffA, diffB, diffA]);
    expect(image.layerFiles).toEqual([
      path.join(root, "blobs/sha256/a"),
      path.join(root, "blobs/sha256/b"),
      path.join(root, "blobs/sha256/a"),
    ]);
  });

  void it("gzips uncompressed layers and passes gzip layers through", async () => {
    await writeSavedImage();
    const plain = await buffer(
      await gzippedLayer(path.join(root, "blobs/sha256/a")),
    );
    expect(gunzipSync(plain).toString()).toBe("plain layer tar");
    const gzipped = await buffer(
      await gzippedLayer(path.join(root, "blobs/sha256/b")),
    );
    expect(gzipped).toEqual(await readFile(path.join(root, "blobs/sha256/b")));
  });

  void it("uploads only missing layers, once each, then the config", async () => {
    const config = await writeSavedImage();
    const { client, uploads, configs } = fakeClient([diffA]);
    const image = await uploadSavedImage(
      client,
      "image app",
      await readSavedImage(root),
    );
    expect(image).toBe(`sha256:${"c".repeat(64)}`);
    expect(uploads.map((u) => u.diffId)).toEqual([diffA]);
    expect(gunzipSync(uploads[0]?.body ?? Buffer.alloc(0)).toString()).toBe(
      "plain layer tar",
    );
    expect(configs).toEqual([config]);
  });

  void it("rejects an image built for another platform", async () => {
    await writeSavedImage("arm64");
    const { client, uploads } = fakeClient([diffA, diffB]);
    await expect(
      uploadSavedImage(client, "image app", await readSavedImage(root)),
    ).rejects.toThrow(/built for arm64.*linux\/amd64/);
    expect(uploads).toEqual([]);
  });
});
