import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { type FileSource, packTar } from "modern-tar/fs";

import { invalidEvalsDir } from "../../errors";

/** A suite is a directory directly inside the evals folder holding a Harbor JobConfig. */
export const SUITE_CONFIG = "harbor.yaml";

/**
 * Never uploaded: VCS data, dependency/build caches, Harbor job output and
 * local env files. The last matter most — uploads are readable by eval code in
 * the sandbox, so secrets travel as env vars, never as files.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "jobs",
]);
const isExcludedFile = (name: string) =>
  name === ".env" || name.startsWith(".env.") || name === ".DS_Store";

export interface WalkResult {
  /** Archive entries, POSIX paths relative to the walked root, sorted. */
  files: FileSource[];
  skippedSymlinks: string[];
}

const fileEntry = (source: string, target: string): FileSource => ({
  type: "file",
  source,
  target,
  mtime: new Date(0),
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
});

/**
 * Walk `root` for packing, minus the upload exclusions. Entries get fixed
 * ownership and mtime so the same tree always packs to the same bytes.
 */
export const walkFiles = async (root: string): Promise<WalkResult> => {
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
        if (!EXCLUDED_DIRS.has(entry.name)) await walk(source, target);
      } else if (entry.isFile() && !isExcludedFile(entry.name)) {
        files.push(fileEntry(source, target));
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

export interface EvalsArchive {
  archive: Buffer;
  fileCount: number;
  skippedSymlinks: string[];
}

/** Suite directory names directly inside `dir`, sorted. */
export const discoverSuites = async (dir: string): Promise<string[]> => {
  const root = path.resolve(dir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw invalidEvalsDir(`Evals folder not found: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const suites: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    const config = await stat(path.join(root, entry.name, SUITE_CONFIG)).catch(
      () => null,
    );
    if (config?.isFile()) suites.push(entry.name);
  }
  if (suites.length === 0) {
    throw invalidEvalsDir(
      `No suites in ${root}: expected <suite>/${SUITE_CONFIG} directly ` +
        "inside it. Pass the evals folder itself, not its parent or a suite.",
    );
  }
  return suites.sort();
};

/**
 * Pack the evals folder's CONTENTS (suites at the archive root, no `evals/`
 * prefix — that is where the orchestrator runs from) into a `.tar.gz`.
 */
export const packEvalsDir = async (dir: string): Promise<EvalsArchive> => {
  const { files, skippedSymlinks } = await walkFiles(path.resolve(dir));
  const archive = await packFiles(files);
  return { archive, fileCount: files.length, skippedSymlinks };
};
