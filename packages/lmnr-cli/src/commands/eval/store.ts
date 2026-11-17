import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import type {
  CreateTaskSetVersionResult,
  EvalAgentVersion,
  LaminarClient,
  TaskSetTask,
} from "@lmnr-ai/client";
import { unpackTar } from "modern-tar/fs";

import { archiveTooLarge } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { dirDigest, treeDigest } from "./digest";
import {
  findTaskDirs,
  readTaskToml,
  STATE_FILE,
  TASK_SETS_DIR,
} from "./layout";
import {
  type Exclude,
  excludeTop,
  type PackedFile,
  packFiles,
  walkFiles,
} from "./pack";

const logger = initializeLogger();

/** The server's cap on one blob (`MAX_ARCHIVE_BYTES`). */
const MAX_BLOB_BYTES = 1024 * 1024 * 1024;

/** An agent's scripts: its dir minus the task sets and local state. */
export const AGENT_SCRIPTS: Exclude = excludeTop(TASK_SETS_DIR, STATE_FILE);
/** A task set's files: its dir minus the local state. */
export const TASK_SET_FILES: Exclude = excludeTop(STATE_FILE);

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Upload `dir`'s files as the blob of their content hash, unless Laminar has
 * it already. Returns the hash.
 */
export const ensureBlob = async (
  client: LaminarClient,
  dir: string,
  exclude: Exclude,
): Promise<string> => {
  const { files, skippedSymlinks } = await walkFiles(
    dir,
    process.platform,
    exclude,
  );
  const hash = await treeDigest(files);
  if (await client.hostedEvals.getBlobIndex(hash)) return hash;
  if (skippedSymlinks.length > 0) {
    logger.warn(
      `Skipped ${skippedSymlinks.length} symlink(s) in ${dir}: ` +
        skippedSymlinks.slice(0, 5).join(", ") +
        (skippedSymlinks.length > 5 ? ", ..." : ""),
    );
  }
  const { archive, index } = await packFiles(files);
  if (archive.length > MAX_BLOB_BYTES) {
    throw archiveTooLarge(
      `${dir} packs to ${formatMiB(archive.length)}, over the ` +
        `${formatMiB(MAX_BLOB_BYTES)} limit. Remove large files from it.`,
    );
  }
  logger.debug(`Uploading ${files.length} files of ${dir}`);
  await client.hostedEvals.putBlob(hash, archive);
  await client.hostedEvals.putBlobIndex(hash, { files: index });
  return hash;
};

/** Extract the blob `hash` into `dest` (created if needed). */
export const downloadBlob = async (
  client: LaminarClient,
  hash: string,
  dest: string,
): Promise<void> => {
  await mkdir(dest, { recursive: true });
  const body = await client.hostedEvals.getBlob(hash);
  await pipeline(
    Readable.fromWeb(body as WebReadableStream<Uint8Array>),
    createGunzip(),
    unpackTar(dest),
  );
};

/** The tasks of a task set dir with their digests and task.toml `[metadata]`. */
export const taskManifest = async (setDir: string): Promise<TaskSetTask[]> => {
  const tasks: TaskSetTask[] = [];
  for (const dir of await findTaskDirs(setDir)) {
    const { metadata } = await readTaskToml(dir);
    tasks.push({
      name: path.basename(dir),
      digest: await dirDigest(dir),
      ...(metadata ? { metadata } : {}),
    });
  }
  return tasks;
};

export const taskDigests = (tasks: TaskSetTask[]): Record<string, string> =>
  Object.fromEntries(tasks.map((t) => [t.name, t.digest]));

/**
 * Digests of a task set's top-level entries that aren't tasks (READMEs, shared
 * data), over the files a blob packs. Recorded with the base version so pull
 * merges them like tasks.
 */
export const otherEntryDigests = async (
  setDir: string,
  tasks: Record<string, string>,
): Promise<Record<string, string>> => {
  const { files } = await walkFiles(setDir, process.platform, TASK_SET_FILES);
  const entries = new Map<string, PackedFile[]>();
  for (const file of files) {
    const top = file.target.split("/")[0];
    if (top in tasks) continue;
    entries.set(top, [...(entries.get(top) ?? []), file]);
  }
  const digests: Record<string, string> = {};
  for (const [name, entryFiles] of entries) {
    digests[name] = await treeDigest(entryFiles);
  }
  return digests;
};

/** A task set dir's task digests and other top-level entries' digests. */
export const setDigests = async (
  setDir: string,
): Promise<{
  tasks: Record<string, string>;
  files: Record<string, string>;
}> => {
  const tasks = taskDigests(await taskManifest(setDir));
  return { tasks, files: await otherEntryDigests(setDir, tasks) };
};

const gitSha = async (dir: string): Promise<string | undefined> => {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: dir,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Record the agent's scripts in `dir` as the ones a run uses. */
export const saveAgentVersion = async (
  client: LaminarClient,
  agent: string,
  dir: string,
): Promise<EvalAgentVersion> => {
  const hash = await ensureBlob(client, dir, AGENT_SCRIPTS);
  const sha = await gitSha(dir);
  return client.hostedEvals.createAgentVersion(agent, {
    hash,
    ...(sha ? { gitSha: sha } : {}),
  });
};

/** Record the task set in `dir` as a version based on `base`. */
export const saveTaskSetVersion = async (
  client: LaminarClient,
  agent: string,
  taskSet: string,
  dir: string,
  { push, base }: { push: boolean; base: string | null },
): Promise<{ result: CreateTaskSetVersionResult; tasks: TaskSetTask[] }> => {
  const hash = await ensureBlob(client, dir, TASK_SET_FILES);
  const tasks = await taskManifest(dir);
  const result = await client.hostedEvals.createTaskSetVersion(agent, taskSet, {
    hash,
    push,
    base,
    tasks,
  });
  return { result, tasks };
};
