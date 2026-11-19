import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

import { createTarDecoder } from "modern-tar";

import { invalidEvalsDir } from "../../errors";
import { HASH, type HashedFile, taskHash } from "./tasks";

/**
 * Root of lmnr-cli's cache: `$LMNR_CACHE_DIR`, else `$XDG_CACHE_HOME/lmnr`,
 * else `~/.cache/lmnr`.
 */
export const cacheRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LMNR_CACHE_DIR?.trim() ||
  path.join(
    env.XDG_CACHE_HOME?.trim() || path.join(homedir(), ".cache"),
    "lmnr",
  );

/** Extracted tasks by hash: `<cache>/eval-tasks/<64 hex>/`. */
const tasksCache = (env?: NodeJS.ProcessEnv) =>
  path.join(cacheRoot(env), "eval-tasks");

/**
 * An archive entry's path as a safe relative path, or null: no absolute
 * paths, drive letters, backslashes, NULs, or `.` / `..` / empty segments.
 */
export const safeEntryPath = (name: string): string | null => {
  const trimmed = name.replace(/\/+$/, "");
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    return null;
  }
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join(path.sep);
};

/**
 * Extract a task's `.tar.gz` into `dest`, a new empty directory. Only regular
 * files and directories are written; anything else (links, devices) or an
 * unsafe path rejects the archive. Files get 0755 or 0644 from their header's
 * execute bits. Nothing outside `dest` is ever touched: paths are relative
 * without `..`, and no links are created that a later entry could follow.
 *
 * Returns the task hash of the archive's entries, with modes from their
 * headers: the same on every OS, unlike re-hashing the extracted files
 * (Windows has no exec bits to read back).
 */
export const extractTaskArchive = async (
  gzipped: ReadableStream<Uint8Array>,
  dest: string,
): Promise<string> => {
  const hashed: HashedFile[] = [];
  const tar = Readable.toWeb(
    Readable.fromWeb(gzipped as NodeReadableStream<Uint8Array>).pipe(
      createGunzip(),
    ),
  ) as unknown as ReadableStream<Uint8Array>;
  const entries = tar.pipeThrough(createTarDecoder({ strict: true }));
  for await (const entry of entries as unknown as AsyncIterable<{
    header: { name: string; type?: string; mode?: number };
    body: ReadableStream<Uint8Array>;
  }>) {
    const { name, type = "file", mode = 0o644 } = entry.header;
    const rel = safeEntryPath(name);
    if (rel === null || (type !== "file" && type !== "directory")) {
      await entry.body.cancel();
      throw new Error(
        `Refusing to extract ${JSON.stringify(name)} (${type}): task archives ` +
          "hold only regular files and directories with relative paths.",
      );
    }
    const target = path.join(dest, rel);
    if (type === "directory") {
      await entry.body.cancel();
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const content = createHash("sha256");
    // `wx`: a duplicate entry fails instead of overwriting.
    await entry.body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            content.update(chunk);
            controller.enqueue(chunk);
          },
        }),
      )
      .pipeTo(
        Writable.toWeb(
          createWriteStream(target, { flags: "wx" }),
        ) as WritableStream<Uint8Array>,
      );
    const fileMode = mode & 0o111 ? 0o755 : 0o644;
    await chmod(target, fileMode);
    hashed.push({
      path: rel.split(path.sep).join("/"),
      mode: fileMode,
      content: content.digest("hex"),
    });
  }
  return taskHash(hashed);
};

/**
 * The extracted task `hash`, downloading it into the cache when it isn't
 * there yet. A download is extracted next to its final place, checked against
 * its hash, and renamed in, so the cache only ever holds complete, verified
 * tasks (concurrent pulls of one task are fine: the second rename loses).
 */
export const ensureCachedTask = async (
  hash: string,
  download: (hash: string) => Promise<ReadableStream<Uint8Array>>,
  env?: NodeJS.ProcessEnv,
): Promise<string> => {
  // It names a cache dir: never let anything but a hash into the path.
  if (!HASH.test(hash))
    throw new Error(`Invalid task hash ${JSON.stringify(hash)}`);
  const root = tasksCache(env);
  const final = path.join(root, hash);
  if ((await stat(final).catch(() => null))?.isDirectory()) return final;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, ".tmp-"));
  try {
    const extracted = path.join(staging, "task");
    await mkdir(extracted);
    const actual = await extractTaskArchive(await download(hash), extracted);
    if (actual !== hash) {
      throw new Error(
        `Downloaded task ${hash} doesn't match its hash (got ${actual}).`,
      );
    }
    try {
      await rename(extracted, final);
    } catch (error) {
      // Another pull cached it first.
      if (!(await stat(final).catch(() => null))?.isDirectory()) throw error;
    }
    return final;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/** Copy a directory of regular files and directories, modes included. */
const copyTree = async (from: string, to: string): Promise<void> => {
  await mkdir(to);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) {
      await copyFile(source, target);
      await chmod(target, (await stat(source)).mode & 0o777);
    }
  }
};

/**
 * Replace `dest` (a task dir in `tasks/`) with a copy of the cached task. The
 * copy is staged in a hidden sibling (never listed as a task) and renamed in.
 * An existing link at `dest` is removed, never followed. `tasks/` must exist
 * (`ensureTasksDir`).
 */
export const installTask = async (
  cached: string,
  dest: string,
): Promise<void> => {
  const parent = path.dirname(dest);
  const staging = path.join(
    parent,
    `.${path.basename(dest)}.lmnr-tmp-${randomBytes(4).toString("hex")}`,
  );
  try {
    await copyTree(cached, staging);
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

/** Remove a task dir (or a link in its place) from `tasks/`. */
export const removeTask = (dir: string) =>
  rm(dir, { recursive: true, force: true });

/**
 * Create `tasks/` if missing. A link or file there is an error: pulled tasks
 * are never written through a link.
 */
export const ensureTasksDir = async (dir: string): Promise<void> => {
  const s = await lstat(dir).catch(() => null);
  if (!s) {
    await mkdir(dir, { recursive: true });
  } else if (!s.isDirectory()) {
    throw invalidEvalsDir(
      `${dir} is ${s.isSymbolicLink() ? "a symlink" : "not a directory"}; ` +
        "eval dataset pull only writes into a real tasks/ directory.",
    );
  }
};
