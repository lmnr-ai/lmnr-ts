import { readdir } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { type FileSource, packTar } from "modern-tar/fs";

import { SKIPPED_DIRS } from "./suites";

/**
 * Never uploaded, besides `SKIPPED_DIRS`: local env files matter most — uploads
 * are readable by eval code in the sandbox, so secrets travel as env vars,
 * never as files.
 */
const isExcludedFile = (name: string) =>
  name === ".env" || name.startsWith(".env.") || name === ".DS_Store";

interface WalkResult {
  /** Archive entries, POSIX paths relative to the walked root, sorted. */
  files: FileSource[];
  skippedSymlinks: string[];
}

/**
 * Windows has no execute bits, so every file stats as non-executable there.
 * Shell scripts get them back by extension, Harbor's own rule (`needs_chmod`).
 */
const windowsMode = (name: string) => (name.endsWith(".sh") ? 0o755 : 0o644);

/** Fixed ownership and mtime: the upload carries no local user names or times. */
const fileEntry = (
  source: string,
  target: string,
  platform: NodeJS.Platform,
): FileSource => ({
  type: "file",
  source,
  target,
  mtime: new Date(0),
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
  ...(platform === "win32" ? { mode: windowsMode(target) } : {}),
});

/** Walk `root` for packing, minus the upload exclusions. */
const walkFiles = async (
  root: string,
  platform: NodeJS.Platform,
): Promise<WalkResult> => {
  const files: FileSource[] = [];
  const skippedSymlinks: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // Sandboxes extract with Python's `filter="data"`, which rejects links
        // that escape the archive; skipping keeps uploads predictable.
        skippedSymlinks.push(target);
      } else if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(source, target);
      } else if (entry.isFile() && !isExcludedFile(entry.name)) {
        files.push(fileEntry(source, target, platform));
      }
    }
  };
  await walk(root, "");
  return { files, skippedSymlinks };
};

const packFiles = async (files: FileSource[]): Promise<Buffer> => {
  const gz = createGzip();
  const [, archive] = await Promise.all([
    pipeline(packTar(files), gz),
    buffer(gz),
  ]);
  return archive;
};

interface EvalsArchive {
  archive: Buffer;
  fileCount: number;
  skippedSymlinks: string[];
}

/**
 * Pack the evals folder's CONTENTS (suites at the archive root, no `evals/`
 * prefix — that is where the orchestrator runs from) into a `.tar.gz`.
 */
export const packEvalsDir = async (
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<EvalsArchive> => {
  const { files, skippedSymlinks } = await walkFiles(
    path.resolve(dir),
    platform,
  );
  const archive = await packFiles(files);
  return { archive, fileCount: files.length, skippedSymlinks };
};
