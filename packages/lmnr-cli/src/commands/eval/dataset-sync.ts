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
 * What pull / push / run know about one dataset, by task name. `local` has
 * the hash of each local task they look at (the `--task` selection); `latest`
 * is each task's latest version in Laminar, null when Laminar has no such
 * dataset; `pins` is null when dataset.toml lists no tasks.
 */
export interface DatasetSnapshot {
  pins: TaskPins | null;
  state: TaskHashes;
  local: TaskHashes;
  latest: TaskHashes | null;
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

const sortedKeys = (record: Record<string, unknown>) =>
  Object.keys(record).sort(compareBytes);

const samePins = (a: TaskPins, b: TaskPins) => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
};

export interface PullOptions {
  /** `--task` globs as a predicate. */
  selected: (task: string) => boolean;
  force: boolean;
  /** `--latest` (implied when dataset.toml lists no tasks). */
  latest: boolean;
}

export interface PullPlan {
  added: TaskVersion[];
  changed: TaskUpdate[];
  removed: TaskVersion[];
  /** Edited tasks the pull would overwrite or delete (refused without --force). */
  edited: string[];
  /** dataset.toml's pins after the pull; `writePins` says whether they change. */
  pins: TaskPins;
  writePins: boolean;
  /** The local state after the pull. */
  state: TaskHashes;
}

/**
 * Plan `eval dataset pull` for one dataset. The target of each selected task
 * is its pin, or with `latest` (or no pins) Laminar's latest version,
 * which then replaces the selected tasks' pins. A task with no local dir
 * is added, one whose hash differs from the target is changed, and one that
 * was pulled here before but is no longer pinned is removed. Changing or
 * removing an edited task (its hash differs from its base, or it has none)
 * needs `force`. `snapshot.latest` must be set when pulling the latest.
 */
export const planPull = (
  { pins, state, local, latest }: DatasetSnapshot,
  { selected, force, latest: pullLatest }: PullOptions,
): PullPlan => {
  const useLatest = pullLatest || pins === null;
  let targets: TaskPins;
  let newPins: TaskPins;
  if (useLatest) {
    targets = Object.fromEntries(
      Object.entries(latest ?? {}).filter(([task]) => selected(task)),
    );
    newPins = {
      ...Object.fromEntries(
        Object.entries(pins ?? {}).filter(([task]) => !selected(task)),
      ),
      ...targets,
    };
  } else {
    targets = Object.fromEntries(
      Object.entries(pins).filter(([task]) => selected(task)),
    );
    newPins = { ...pins };
  }

  const plan: PullPlan = {
    added: [],
    changed: [],
    removed: [],
    edited: [],
    pins: newPins,
    writePins: pins === null || !samePins(pins, newPins),
    state: { ...state },
  };
  const isEdited = (task: string) =>
    state[task] === undefined || local[task] !== state[task];

  for (const task of sortedKeys(targets)) {
    const target = targets[task];
    const current = local[task];
    if (current === undefined) {
      plan.added.push({ task, hash: target });
    } else if (current !== target) {
      plan.changed.push({ task, from: current, to: target });
      if (isEdited(task) && !force) plan.edited.push(task);
    }
    plan.state[task] = target;
  }
  for (const task of sortedKeys(state)) {
    if (!selected(task) || task in newPins) continue;
    delete plan.state[task];
    if (local[task] === undefined) continue;
    plan.removed.push({ task, hash: local[task] });
    if (isEdited(task) && !force) plan.edited.push(task);
  }
  return plan;
};

/** Why push refuses a task: its pin moved since it was pulled here. */
export interface MovedTask {
  task: string;
  /** `laminar`: Laminar's latest moved; `pin`: dataset.toml's pin moved. */
  where: "laminar" | "pin";
  /** The version it moved to. */
  to: string;
}

export interface PushTask extends TaskVersion {
  /** Laminar's latest when planned: the push fails if it moved since. */
  base: string | null;
}

export interface PushPlan {
  added: PushTask[];
  changed: (PushTask & { from: string })[];
  removed: TaskVersion[];
  moved: MovedTask[];
  /** dataset.toml's pins after the push; `writePins` says whether they change. */
  pins: TaskPins;
  writePins: boolean;
  state: TaskHashes;
}

/**
 * Plan `eval dataset push` for one dataset (`snapshot.local`: the selected
 * local task dirs). A task is refused as moved when Laminar's latest moved
 * past its base, when dataset.toml pins another version than its base (moved
 * without a pull here), or, never pulled here, when Laminar already has
 * another latest version. A task whose hash is Laminar's latest and its pin
 * is unchanged; others are added (no pin) or changed. A task pulled here
 * before whose dir is gone loses its pin (Laminar keeps it).
 */
export const planPush = (
  { pins, state, local, latest }: DatasetSnapshot,
  selected: (task: string) => boolean,
): PushPlan => {
  const plan: PushPlan = {
    added: [],
    changed: [],
    removed: [],
    moved: [],
    pins: { ...(pins ?? {}) },
    writePins: false,
    state: { ...state },
  };
  for (const task of sortedKeys(local)) {
    const hash = local[task];
    const base = state[task];
    const pin = pins?.[task];
    const current = latest?.[task];
    if (base !== undefined && current !== undefined && current !== base) {
      plan.moved.push({ task, where: "laminar", to: current });
      continue;
    }
    if (base !== undefined && pin !== undefined && pin !== base) {
      plan.moved.push({ task, where: "pin", to: pin });
      continue;
    }
    if (base === undefined && current !== undefined && current !== hash) {
      plan.moved.push({ task, where: "laminar", to: current });
      continue;
    }
    plan.state[task] = hash;
    if (hash === current && hash === pin) continue;
    // Whatever base this disk had, it equals Laminar's latest here (or the
    // task is new to Laminar): that is what the server checks against.
    const update = { task, hash, base: current ?? null };
    if (pin === undefined) plan.added.push(update);
    else plan.changed.push({ ...update, from: pin });
    plan.pins[task] = hash;
  }
  for (const task of sortedKeys(state)) {
    if (!selected(task) || local[task] !== undefined) continue;
    if (pins?.[task] === undefined) continue;
    plan.removed.push({ task, hash: pins[task] });
    delete plan.pins[task];
    delete plan.state[task];
  }
  plan.writePins =
    pins === null
      ? Object.keys(plan.pins).length > 0
      : !samePins(pins, plan.pins);
  return plan;
};

export interface RunPullPlan {
  /** Pinned tasks to pull before the run: missing, or unedited with a new pin. */
  pull: TaskVersion[];
  /** Edited tasks whose pin differs: they run as they are. */
  edited: TaskVersion[];
}

/**
 * What `eval run` pulls first: each selected pinned task whose dir is
 * missing, or whose dir is unedited (still its base) but pinned to another
 * version. Edited tasks run as they are.
 */
export const planRunPull = (
  { pins, state, local }: Pick<DatasetSnapshot, "pins" | "state" | "local">,
  selected: (task: string) => boolean,
): RunPullPlan => {
  const plan: RunPullPlan = { pull: [], edited: [] };
  for (const task of sortedKeys(pins ?? {})) {
    if (!selected(task)) continue;
    const pin = (pins as TaskPins)[task];
    const current = local[task];
    if (current === undefined) plan.pull.push({ task, hash: pin });
    else if (current === pin) continue;
    else if (state[task] !== undefined && current === state[task]) {
      plan.pull.push({ task, hash: pin });
    } else plan.edited.push({ task, hash: pin });
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
