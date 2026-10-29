import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { dockerFailed } from "../../errors";
import { initializeLogger } from "../../utils/logger";

const logger = initializeLogger();

/** Laminar sandboxes run on x86_64, whatever this machine is. */
export const REMOTE_PLATFORM = "linux/amd64";
const GZIP_MAGIC = [0x1f, 0x8b];
const ZSTD_MAGIC = [0x28, 0xb5];

/** A `docker save` archive, unpacked. */
interface SavedImage {
  /** The image config JSON exactly as saved: its digest is the image id. */
  config: string;
  /** From the config, e.g. `amd64`. */
  architecture?: string;
  /** Uncompressed digest of each layer (`rootfs.diff_ids`), bottom first. */
  diffIds: string[];
  /** Each layer's file, in the same order. */
  layerFiles: string[];
}

const readManifest = async (dir: string) => {
  const [entry] = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as { Config: string; Layers: string[] }[];
  if (!entry) throw new Error("manifest.json lists no image");
  const config = await readFile(path.join(dir, entry.Config), "utf8");
  const parsed = JSON.parse(config) as {
    architecture?: string;
    rootfs?: { diff_ids?: string[] };
  };
  return { entry, config, parsed };
};

/**
 * Read an unpacked `docker save` archive. Both image stores write a
 * `manifest.json` listing the config and layers (the containerd store adds an
 * OCI layout next to it, with the same files).
 */
export const readSavedImage = async (dir: string): Promise<SavedImage> => {
  const { entry, config, parsed } = await readManifest(dir).catch(
    (error: unknown) => {
      throw dockerFailed(
        `Can't read the docker save output: ${errorMessage(error)}`,
      );
    },
  );
  const diffIds = parsed.rootfs?.diff_ids ?? [];
  if (diffIds.length !== entry.Layers.length) {
    throw dockerFailed(
      `docker save listed ${entry.Layers.length} layers for ${diffIds.length} diff_ids`,
    );
  }
  return {
    config,
    architecture: parsed.architecture,
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
  if (head[0] === ZSTD_MAGIC[0] && head[1] === ZSTD_MAGIC[1]) {
    raw.destroy();
    throw dockerFailed(
      `${path.basename(file)} is zstd-compressed, which Laminar sandboxes ` +
        "can't use yet. Rebuild the image with gzip or uncompressed layers.",
    );
  }
  return raw.pipe(createGzip());
};

/**
 * Upload the layers the project doesn't have yet, then push the image.
 * Returns its manifest digest. `name` is the image's display name.
 */
export const uploadSavedImage = async (
  client: LaminarClient,
  name: string,
  image: SavedImage,
): Promise<string> => {
  if (image.architecture !== "amd64") {
    throw dockerFailed(
      `${name} is built for ${image.architecture ?? "an unknown platform"}; ` +
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
      `Uploading ${name} layer ${index + 1}/${image.diffIds.length} ` +
        `(${(size / 1024 / 1024).toFixed(1)} MiB before compression)`,
    );
    const body = Readable.toWeb(
      await gzippedLayer(file),
    ) as ReadableStream<Uint8Array>;
    await client.hostedEvals.uploadLayer(diffId, body);
    uploaded++;
  }
  if (uploaded === 0) {
    logger.info(`All ${name} layers are already uploaded`);
  }
  return (await client.hostedEvals.createImage(image.config)).image;
};
