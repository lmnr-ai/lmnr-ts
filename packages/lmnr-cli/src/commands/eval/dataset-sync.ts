import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import { unpackTar } from "modern-tar/fs";

import {
  archiveTooLarge,
  CliError,
  storageNotConfigured,
  versionNotFound,
} from "../../errors";
import type { TaskHashes } from "./dataset-state";
import { compareBytes, type TaskPins } from "./dataset-toml";
import { TASKS_DIR } from "./datasets";
import { hashTaskDir, packTaskDir } from "./task-hash";

/**
 * What pull / push know about one dataset, by task name. `local` has the hash
 * of each local task they look at (the `--task` selection); `missing` is the
 * part of `local` Laminar doesn't have; `pins` is null when dataset.toml
 * lists no tasks. Versions are independent: Laminar keeps no "latest".
 */
export interface DatasetSnapshot {
  pins: TaskPins | null;
  local: TaskHashes;
  missing: TaskHashes;
}

export interface TaskVersion {
  task: string;
  hash: string;
}

export interface TaskUpdate {
  task: string;
  from: string;
  to: string;
}

/** Why a local task was left alone. */
export type SkipReason =
  /** Pull: not pinned, and Laminar doesn't have it (a new task). */
  | "unpushed"
  /** Push: Laminar has it, and dataset.toml pins another version. */
  | "outdated"
  /** Push: not pinned, and Laminar has it (removed from dataset.toml). */
  | "unpinned";

export interface SkippedTask extends TaskVersion {
  reason: SkipReason;
}

const sortedKeys = (record: Record<string, unknown>) =>
  Object.keys(record).sort(compareBytes);

export interface PullPlan {
  added: TaskVersion[];
  changed: TaskUpdate[];
  removed: TaskVersion[];
  skipped: SkippedTask[];
  /**
   * Tasks the pull would overwrite or delete whose local version Laminar
   * doesn't have (edits): refused without `force`.
   */
  conflicts: string[];
}

/**
 * Plan `eval dataset pull` for one dataset: make the selected tasks match
 * dataset.toml's pins. A pinned task with no local dir is added, one whose
 * hash differs from its pin is changed, and an unpinned one Laminar has is
 * removed (it was dropped from dataset.toml). An unpinned one Laminar doesn't
 * have is a new task, left alone. Overwriting a version Laminar doesn't have
 * is a conflict unless `force`. Never changes the pins.
 */
export const planPull = (
  { pins, local, missing }: DatasetSnapshot,
  { selected, force }: { selected: (task: string) => boolean; force: boolean },
): PullPlan => {
  const plan: PullPlan = {
    added: [],
    changed: [],
    removed: [],
    skipped: [],
    conflicts: [],
  };
  const unsaved = (task: string) => task in missing && !force;
  const targets = pins ?? {};
  for (const task of sortedKeys(targets)) {
    if (!selected(task)) continue;
    const target = targets[task];
    const current = local[task];
    if (current === undefined) {
      plan.added.push({ task, hash: target });
    } else if (current !== target) {
      plan.changed.push({ task, from: current, to: target });
      if (unsaved(task)) plan.conflicts.push(task);
    }
  }
  for (const task of sortedKeys(local)) {
    if (task in targets || !selected(task)) continue;
    const hash = local[task];
    if (task in missing) plan.skipped.push({ task, hash, reason: "unpushed" });
    else plan.removed.push({ task, hash });
  }
  return plan;
};

export interface PushPlan {
  /** Versions to upload and pin: new tasks, and edits of pinned ones. */
  added: TaskVersion[];
  changed: TaskUpdate[];
  /**
   * Versions already pinned that Laminar doesn't have (e.g. digests `harbor
   * sync` wrote, or a push that failed before): uploaded, pins unchanged.
   */
  stored: TaskVersion[];
  skipped: SkippedTask[];
}

/**
 * Plan `eval dataset push` for one dataset (`snapshot.local`: the selected
 * local task dirs). A task whose hash is its pin is up to date, or uploaded
 * if Laminar doesn't have it. Another one Laminar doesn't have is uploaded
 * and pinned (added, or changed from its pin). One
 * Laminar has under another pin is outdated, and one Laminar has with no pin
 * was dropped from dataset.toml: both are skipped. Pinned tasks with no
 * local dir keep their pins.
 */
export const planPush = ({
  pins,
  local,
  missing,
}: DatasetSnapshot): PushPlan => {
  const plan: PushPlan = {
    added: [],
    changed: [],
    stored: [],
    skipped: [],
  };
  for (const task of sortedKeys(local)) {
    const hash = local[task];
    const pin = pins?.[task];
    if (hash === pin) {
      if (task in missing) plan.stored.push({ task, hash });
      continue;
    }
    if (!(task in missing)) {
      plan.skipped.push({
        task,
        hash,
        reason: pin === undefined ? "unpinned" : "outdated",
      });
      continue;
    }
    if (pin === undefined) plan.added.push({ task, hash });
    else plan.changed.push({ task, from: pin, to: hash });
  }
  return plan;
};

/** The `code` of a `LaminarApiError` from the client, if any. */
export const apiErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || error.name !== "LaminarApiError") {
    return undefined;
  }
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" ? code : undefined;
};

/**
 * Turn the eval dataset API's coded errors into CLI errors; others pass
 * through unchanged.
 */
export const datasetApiError = (error: unknown): unknown => {
  if (error instanceof CliError) return error;
  if (apiErrorCode(error) === "storage_not_configured") {
    return storageNotConfigured(
      "This Laminar deployment has no storage for eval datasets (S3 storage " +
        "is not configured), so tasks can't be pulled or pushed. Run with " +
        "the tasks already in tasks/, or configure storage on the server.",
    );
  }
  return error;
};

/**
 * Run `fn` on each item, at most `limit` at a time. After a failure no new
 * item starts; once the running ones settle, the first error is thrown (so
 * callers record what did finish).
 */
export const forEachLimit = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failure) throw failure.error;
};

/** Concurrent downloads / uploads per dataset. */
export const TRANSFER_CONCURRENCY = 4;

/** The server's cap on a version archive. */
const MAX_VERSION_BYTES = 1024 * 1024 * 1024;

const tempName = (prefix: string, dir: string) =>
  `.lmnr-${prefix}-${dir}-${randomBytes(4).toString("hex")}`;

/**
 * Extract a version archive into `dir` (which must not exist): only regular
 * files and directories, nothing outside `dir` (modern-tar rejects such
 * paths), modes `0o755` / `0o644` by the exec bit, current mtimes.
 */
export const extractVersion = async (
  archive: NodeJS.ReadableStream | Readable,
  dir: string,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await pipeline(
    archive,
    createGunzip(),
    unpackTar(dir, {
      filter: (header) => header.type === "file" || header.type === "directory",
      map: (header) => ({
        ...header,
        mode:
          header.type === "directory" || ((header.mode ?? 0) & 0o111) !== 0
            ? 0o755
            : 0o644,
        mtime: undefined,
        uid: undefined,
        gid: undefined,
      }),
    }),
  );
};

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A task version and the dir under `tasks/` it is (or goes) in. */
export interface PlacedVersion extends TaskVersion {
  dir: string;
}

/**
 * Download a task version into `<datasetDir>/tasks/<dir>`: extracted into a
 * temp dir next to it, checked against `hash`, then swapped into place, so a
 * failure leaves the old dir as it was.
 */
export const installTaskVersion = async (
  client: LaminarClient,
  datasetDir: string,
  dataset: string,
  { task, hash, dir }: PlacedVersion,
): Promise<void> => {
  const tasksDir = path.join(datasetDir, TASKS_DIR);
  await mkdir(tasksDir, { recursive: true });
  const temp = path.join(tasksDir, tempName("pull", dir));
  try {
    let body: ReadableStream<Uint8Array>;
    try {
      body = await client.evalDatasets.downloadVersion(dataset, task, hash);
    } catch (error) {
      if (apiErrorCode(error) === "version_not_found") {
        throw versionNotFound(
          `Laminar has no version ${hash} of task ${task} in dataset ` +
            `${dataset}.`,
        );
      }
      throw datasetApiError(error);
    }
    await extractVersion(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      temp,
    );
    const got = await hashTaskDir(temp);
    if (got !== hash) {
      throw new Error(
        `Downloaded ${dataset} task ${task} hashes to ${got}, not ${hash}: ` +
          "the version in Laminar doesn't match its hash.",
      );
    }
    const dest = path.join(tasksDir, dir);
    const old = path.join(tasksDir, tempName("old", dir));
    const hadOld = await exists(dest);
    if (hadOld) await rename(dest, old);
    await rename(temp, dest);
    if (hadOld) await rm(old, { recursive: true, force: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};

/** Delete `<datasetDir>/tasks/<dir>`. */
export const removeTaskDir = async (
  datasetDir: string,
  dir: string,
): Promise<void> => {
  await rm(path.join(datasetDir, TASKS_DIR, dir), {
    recursive: true,
    force: true,
  });
};

/**
 * Pack `<datasetDir>/tasks/<dir>` and upload it as version `hash`: the
 * archive, then its index, which makes the version count. Fails if the dir
 * changed since it was hashed.
 */
export const uploadTaskVersion = async (
  client: LaminarClient,
  datasetDir: string,
  dataset: string,
  { task, hash, dir }: PlacedVersion,
): Promise<void> => {
  const packed = await packTaskDir(path.join(datasetDir, TASKS_DIR, dir));
  if (packed.hash !== hash) {
    throw new CliError(
      "task_changed",
      1,
      `Task ${task} of ${dataset} changed while pushing; push again.`,
    );
  }
  if (packed.archive.length > MAX_VERSION_BYTES) {
    throw archiveTooLarge(
      `Task ${task} of ${dataset} packs to ` +
        `${(packed.archive.length / 1024 / 1024).toFixed(1)} MiB, over the ` +
        "1 GiB limit of a task version.",
    );
  }
  try {
    await client.evalDatasets.uploadVersion(
      dataset,
      task,
      hash,
      packed.archive,
    );
    await client.evalDatasets.uploadVersionIndex(dataset, task, hash, {
      files: packed.index,
    });
  } catch (error) {
    throw datasetApiError(error);
  }
};

/** Short form of a hash for messages. */
export const shortHash = (hash: string) => hash.slice(0, 12);

/** `errorMessage` for errors thrown while transferring one task. */
export const transferError = (
  verb: string,
  dataset: string,
  task: string,
  error: unknown,
): unknown =>
  error instanceof CliError
    ? error
    : new Error(
        `Could not ${verb} ${task} of ${dataset}: ${errorMessage(error)}`,
      );
