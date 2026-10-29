import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { Ignore } from "ignore";
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

export interface WalkOptions {
  /** Apply the evals-upload exclusions (VCS, caches, job output, env files). */
  defaultExclusions: boolean;
  /** Extra `.dockerignore`-style rules, relative to the root. */
  ignore?: Ignore;
  /**
   * Walk only these files and directories (POSIX paths relative to the root)
   * instead of the whole root. A missing one is an error.
   */
  include?: string[];
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
 * Walk `root` for packing. Entries get fixed ownership and mtime so the same
 * tree always packs to the same bytes (build contexts are cached by hash).
 */
export const walkFiles = async (
  root: string,
  { defaultExclusions, ignore, include }: WalkOptions,
): Promise<WalkResult> => {
  const skipDir = (name: string, target: string) =>
    (defaultExclusions && EXCLUDED_DIRS.has(name)) ||
    !!ignore?.ignores(`${target}/`);
  const skipFile = (name: string, target: string) =>
    (defaultExclusions && isExcludedFile(name)) || !!ignore?.ignores(target);
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
        if (!skipDir(entry.name, target)) {
          await walk(source, target);
        }
      } else if (entry.isFile() && !skipFile(entry.name, target)) {
        files.push(fileEntry(source, target));
      }
    }
  };
  if (!include) {
    await walk(root, "");
    return { files, skippedSymlinks };
  }
  for (const target of include) {
    const source = path.join(root, ...target.split("/"));
    const entry = await lstat(source).catch(() => null);
    if (!entry) {
      throw invalidEvalsDir(`Included path not found: ${source}`);
    }
    const name = path.basename(source);
    if (entry.isSymbolicLink()) {
      skippedSymlinks.push(target);
    } else if (entry.isDirectory()) {
      if (!skipDir(name, target)) await walk(source, target);
    } else if (entry.isFile() && !skipFile(name, target)) {
      files.push(fileEntry(source, target));
    }
  }
  // Overlapping paths (`app`, `app/main.py`) list a file twice; the archive
  // needs each once, in an order that doesn't depend on how `include` is written.
  const unique = [...new Map(files.map((f) => [f.target, f])).values()];
  unique.sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  return { files: unique, skippedSymlinks };
};

export const packFiles = async (
  files: FileSource[],
  gzip: boolean,
): Promise<Buffer> => {
  if (!gzip) {
    return buffer(packTar(files));
  }
  const gz = createGzip();
  const [, archive] = await Promise.all([
    pipeline(packTar(files), gz),
    buffer(gz),
  ]);
  return archive;
};

export const md5 = (data: Uint8Array): string =>
  createHash("md5").update(data).digest("hex");

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
  const { files, skippedSymlinks } = await walkFiles(path.resolve(dir), {
    defaultExclusions: true,
  });
  const archive = await packFiles(files, true);
  return { archive, fileCount: files.length, skippedSymlinks };
};
