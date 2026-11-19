import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import ignore, { type Ignore } from "ignore";

import { invalidEvalsDir } from "../../errors";
import { compareBytes } from "./dataset-toml";
import { fileEntry, fileMode, type PackedFile, packFiles } from "./pack";

/**
 * A task version is Harbor's own content hash of the task dir
 * (`harbor.publisher.packager.Packager`, Harbor 0.25.0), so the digests in
 * `dataset.toml` are the ones `harbor sync` / `harbor publish` compute. Only
 * the files Harbor packages count, and are uploaded: the ones below plus the
 * `DIRS`, minus `.harborignore` rules (in `tests/` and `solution/`) and the
 * task's `.gitignore` (else `DEFAULT_IGNORES`).
 */
const SINGLE_FILES = [
  "task.toml",
  "instruction.md",
  "README.md",
  "trajectory.json",
];
const DIRS = ["environment", "tests", "solution", "steps"];
const DEFAULT_IGNORES = [
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
  "*.swp",
  "*.swo",
  "*~",
];
const HARBORIGNORE = ".harborignore";

/** sha256 hex of a file's content, streamed. */
const fileSha256 = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

/**
 * Harbor's `.harborignore` scopes (`TaskFileFilter._IGNORE_SCOPES`):
 * `/tests/`, `/solution/`, `/steps/*\/tests/`, `/steps/*\/solution/`.
 */
const inScope = (rel: string, isDir: boolean): boolean => {
  const parts = rel.split("/");
  const scoped = (depth: number) =>
    (parts[depth] === "tests" || parts[depth] === "solution") &&
    (parts.length > depth + 1 || isDir);
  return scoped(0) || (parts[0] === "steps" && parts.length >= 3 && scoped(2));
};

const stats = (p: string) => stat(p).catch(() => null);

/** Python's `pathspec` matches case-sensitively; `ignore` doesn't by default. */
const gitignore = () => ignore({ ignorecase: false });

/** `TaskFileFilter`: whether `.harborignore` rules leave `rel` out. */
const harborFilter = (taskDir: string) => {
  const specs = new Map<string, Promise<Ignore>>();
  const spec = (dir: string) => {
    let found = specs.get(dir);
    if (!found) {
      found = readFile(path.join(taskDir, dir, HARBORIGNORE), "utf8").then(
        (text) => gitignore().add(text),
        () => gitignore(),
      );
      specs.set(dir, found);
    }
    return found;
  };
  return async (rel: string, isDir: boolean): Promise<boolean> => {
    if (path.posix.basename(rel) === HARBORIGNORE) return true;
    if (!inScope(rel, isDir)) return false;
    const parts = rel.split("/");
    const applied: [string, Ignore][] = [];
    let candidate = "";
    for (let i = 0; i < parts.length; i++) {
      if (candidate && inScope(candidate, true)) {
        applied.push([candidate, await spec(candidate)]);
      }
      candidate = candidate ? `${candidate}/${parts[i]}` : parts[i];
      const candidateIsDir = i < parts.length - 1 || isDir;
      if (!inScope(candidate, candidateIsDir)) continue;
      let excluded = false;
      for (const [dir, rules] of applied) {
        const result = rules.test(
          candidate.slice(dir.length + 1) + (candidateIsDir ? "/" : ""),
        );
        if (result.ignored) excluded = true;
        else if (result.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  };
};

export interface TaskFiles {
  /** What Harbor packages and hashes, sorted by path. */
  files: PackedFile[];
  /**
   * The ignore files that chose them (the task's `.gitignore`, the
   * `.harborignore`s Harbor read): not hashed, but packed, so a pulled copy
   * selects (and hashes) the same files.
   */
  ignoreFiles: PackedFile[];
}

/**
 * The files Harbor packages from `taskDir` (`Packager.collect_files`), as
 * archive entries sorted by path. Like Harbor, links to files are followed
 * (and packed as regular files) and links to directories are not walked; a
 * link that leaves the task dir is an error, as Harbor refuses it at run
 * time.
 */
export const collectTaskFiles = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TaskFiles> => {
  const root = await realpath(taskDir);
  const excluded = harborFilter(root);
  const found: string[] = [];
  const ignoreFiles: string[] = [];
  for (const name of SINGLE_FILES) {
    if ((await stats(path.join(root, name)))?.isFile()) found.push(name);
  }
  const visit = async (rel: string) => {
    const entries = await readdir(path.join(root, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      const isDir = entry.isDirectory();
      if (entry.name === HARBORIGNORE && entry.isFile() && inScope(rel, true)) {
        ignoreFiles.push(child);
      }
      if (await excluded(child, isDir)) continue;
      if (isDir) await visit(child);
      else if ((await stats(path.join(root, child)))?.isFile()) {
        found.push(child);
      }
    }
  };
  for (const dir of DIRS) {
    if ((await stats(path.join(root, dir)))?.isDirectory()) {
      if (!(await excluded(dir, true))) await visit(dir);
    }
  }

  const ignoreFile = await readFile(
    path.join(root, ".gitignore"),
    "utf8",
  ).catch(() => null);
  if (ignoreFile !== null) ignoreFiles.push(".gitignore");
  const rules = gitignore().add(ignoreFile ?? DEFAULT_IGNORES);
  const entries = async (rels: string[]) => {
    const out: PackedFile[] = [];
    for (const rel of rels) {
      const source = await realpath(path.join(root, rel));
      if (source !== root && !source.startsWith(root + path.sep)) {
        throw invalidEvalsDir(
          `${path.join(taskDir, rel)} links outside its task; Harbor ` +
            "refuses such links. Copy the file into the task instead.",
        );
      }
      const { size, mode } = await stat(source);
      out.push(fileEntry(source, rel, size, fileMode(rel, mode, platform)));
    }
    return out.sort((a, b) => compareBytes(a.target, b.target));
  };
  return {
    files: await entries(found.filter((f) => !rules.ignores(f))),
    ignoreFiles: await entries(ignoreFiles),
  };
};

/**
 * Harbor's content hash over `files` (as {@link collectTaskFiles} lists
 * them): sha256 hex of `"<path>\0<sha256hex(content)>\n"` per file, by path.
 * File modes don't count.
 */
export const hashFiles = async (files: PackedFile[]): Promise<string> => {
  const sorted = [...files].sort((a, b) => compareBytes(a.target, b.target));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(`${file.target}\0${await fileSha256(file.source)}\n`);
  }
  return hash.digest("hex");
};

/** The task dir's version hash. */
export const hashTaskDir = async (taskDir: string): Promise<string> =>
  hashFiles((await collectTaskFiles(taskDir)).files);

/** Task files Laminar won't store: local env files may hold secrets. */
export const envFiles = (files: PackedFile[]): string[] =>
  files
    .filter((f) => path.posix.basename(f.target).startsWith(".env"))
    .map((f) => f.target);

/**
 * The task dir as a version archive (paths relative to it, the ignore files
 * included), and its hash.
 */
export const packTaskDir = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
) => {
  const { files, ignoreFiles } = await collectTaskFiles(taskDir, platform);
  const packed = [...files, ...ignoreFiles].sort((a, b) =>
    compareBytes(a.target, b.target),
  );
  const [hash, archive] = await Promise.all([
    hashFiles(files),
    packFiles(packed),
  ]);
  return { hash, files, ...archive };
};
