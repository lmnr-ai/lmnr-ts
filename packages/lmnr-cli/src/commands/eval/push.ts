import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { unpackTar } from "modern-tar/fs";

import { harborFailed, invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { dockerBuild, runCommand } from "./harbor";
import type { ImagePusher } from "./images";

const logger = initializeLogger();

/** Laminar sandboxes run on x86_64, whatever this machine is. */
const REMOTE_PLATFORM = "linux/amd64";
const GZIP_MAGIC = [0x1f, 0x8b];

/** A `docker save` archive, unpacked. */
export interface SavedImage {
  /** The image config JSON exactly as saved: its digest is the image id. */
  config: string;
  /** Uncompressed digest of each layer (`rootfs.diff_ids`), bottom first. */
  diffIds: string[];
  /** Each layer's file, in the same order. */
  layerFiles: string[];
}

/**
 * Read an unpacked `docker save` archive. Both image stores write a
 * `manifest.json` listing the config and layers (the containerd store adds an
 * OCI layout next to it, with the same files).
 */
export const readSavedImage = async (dir: string): Promise<SavedImage> => {
  const manifest = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as { Config: string; Layers: string[] }[];
  const entry = manifest[0];
  if (!entry) throw new Error("docker save wrote no image");
  const config = await readFile(path.join(dir, entry.Config), "utf8");
  const parsed = JSON.parse(config) as {
    architecture?: string;
    rootfs?: { diff_ids?: string[] };
  };
  const diffIds = parsed.rootfs?.diff_ids ?? [];
  if (diffIds.length !== entry.Layers.length) {
    throw new Error(
      `docker save listed ${entry.Layers.length} layers for ${diffIds.length} diff_ids`,
    );
  }
  return {
    config,
    diffIds,
    layerFiles: entry.Layers.map((layer) => path.join(dir, layer)),
  };
};

/**
 * A layer as the registry stores it: gzip. `docker save` writes layers
 * uncompressed (classic store) or as pulled (containerd store, usually gzip).
 */
export const gzippedLayer = async (file: string): Promise<Readable> => {
  const handle = await open(file, "r");
  const head = Buffer.alloc(2);
  try {
    await handle.read(head, 0, 2, 0);
  } finally {
    await handle.close();
  }
  const raw = createReadStream(file);
  if (head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) return raw;
  // An uncompressed tar starts with a file name; zstd starts with 28 b5 2f fd.
  if (head[0] === 0x28 && head[1] === 0xb5) {
    raw.destroy();
    throw new Error(
      `${path.basename(file)} is zstd-compressed, which Laminar sandboxes ` +
        "can't use yet. Rebuild the image with gzip or uncompressed layers.",
    );
  }
  return raw.pipe(createGzip());
};

/** Upload the layers the project doesn't have yet, then push the image. */
export const uploadSavedImage = async (
  client: LaminarClient,
  label: string,
  image: SavedImage,
): Promise<string> => {
  const architecture = (JSON.parse(image.config) as { architecture?: string })
    .architecture;
  if (architecture !== "amd64") {
    throw invalidEvalsDir(
      `${label} is built for ${architecture ?? "an unknown platform"}; ` +
        `Laminar sandboxes run ${REMOTE_PLATFORM}.`,
    );
  }
  const missing = new Set(
    await client.hostedEvals.missingLayers([...new Set(image.diffIds)]),
  );
  let uploaded = 0;
  for (const [index, diffId] of image.diffIds.entries()) {
    if (!missing.delete(diffId)) continue;
    const file = image.layerFiles[index] as string;
    const size = (await stat(file)).size;
    logger.info(
      `Uploading ${label} layer ${index + 1}/${image.diffIds.length} ` +
        `(${(size / 1024 / 1024).toFixed(1)} MiB before compression)`,
    );
    const body = Readable.toWeb(
      await gzippedLayer(file),
    ) as ReadableStream<Uint8Array>;
    await client.hostedEvals.uploadLayer(diffId, body);
    uploaded++;
  }
  if (uploaded === 0) {
    logger.info(`All ${label} layers are already uploaded`);
  }
  return (await client.hostedEvals.createImage(image.config)).image;
};

/** Local tag for an image pushed for a remote run, one per image. */
const remoteTag = (label: string) =>
  `lmnr-evals-remote:${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;

/** `docker save` the image tagged `tag` and push it through the Laminar API. */
const saveAndUpload = async (
  client: LaminarClient,
  tag: string,
  label: string,
): Promise<string> => {
  const work = await mkdtemp(path.join(tmpdir(), "lmnr-image-"));
  try {
    const archive = path.join(work, "image.tar");
    const saved = await runCommand("docker", ["save", "-o", archive, tag]);
    if (saved !== 0) {
      throw harborFailed(`docker save of ${label} failed (${saved}).`);
    }
    const unpacked = path.join(work, "image");
    await pipeline(createReadStream(archive), unpackTar(unpacked));
    await rm(archive);
    return await uploadSavedImage(
      client,
      label,
      await readSavedImage(unpacked),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

/**
 * Builds images for Laminar sandboxes with local Docker for `linux/amd64` and
 * pushes them through the Laminar API, uploading only the layers it lacks.
 */
export const imagePusher = (client: LaminarClient): ImagePusher => ({
  build: async (def, label) => {
    const tag = remoteTag(label);
    logger.info(`Building ${label} for ${REMOTE_PLATFORM}`);
    await dockerBuild(def, tag, ["--platform", REMOTE_PLATFORM]);
    return saveAndUpload(client, tag, label);
  },
  pull: async (ref) => {
    // A `FROM`-only build fetches the linux/amd64 variant and saves like any
    // built image, even when the registry serves a multi-platform index.
    const label = `image ${ref}`;
    const tag = remoteTag(label);
    const dir = await mkdtemp(path.join(tmpdir(), "lmnr-pull-"));
    try {
      await writeFile(path.join(dir, "Dockerfile"), `FROM ${ref}\n`);
      logger.info(`Pulling ${ref} for ${REMOTE_PLATFORM}`);
      await dockerBuild(
        { name: ref, dockerfile: path.join(dir, "Dockerfile"), context: dir },
        tag,
        ["--platform", REMOTE_PLATFORM],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return saveAndUpload(client, tag, label);
  },
});
