import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { type PackedFile, packFiles, walkFiles } from "./pack";
import { compareBytes } from "./tasks-toml";

/** sha256 hex of a file's content, streamed. */
const fileSha256 = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

/**
 * A task version's hash over `files` (as `walkFiles` lists them): sha256 hex
 * of `"<mode> <sha256hex(content)> <path>\n"` per file, sorted by path
 * bytewise, `mode` being `755` or `644`.
 */
export const hashFiles = async (files: PackedFile[]): Promise<string> => {
  const sorted = [...files].sort((a, b) => compareBytes(a.target, b.target));
  const hash = createHash("sha256");
  for (const file of sorted) {
    const mode = file.mode === 0o755 ? "755" : "644";
    hash.update(`${mode} ${await fileSha256(file.source)} ${file.target}\n`);
  }
  return hash.digest("hex");
};

/**
 * The task dir's version hash. Every regular file counts except symlinks,
 * `.env*`, `.DS_Store` and `SKIPPED_DIRS`: exactly what
 * {@link packTaskDir} puts in the version's archive.
 */
export const hashTaskDir = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> => hashFiles((await walkFiles(taskDir, platform)).files);

/** The task dir as a version archive (paths relative to it), and its hash. */
export const packTaskDir = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
) => {
  const { files } = await walkFiles(taskDir, platform);
  const [hash, packed] = await Promise.all([
    hashFiles(files),
    packFiles(files),
  ]);
  return { hash, ...packed };
};
