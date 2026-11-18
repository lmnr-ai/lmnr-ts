import path from "node:path";

import type { EvalDatasetVersion, LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import { InvalidArgumentError } from "commander";

import type { GlobalOpts } from "../../auth/with-client";
import {
  archiveTooLarge,
  datasetNotFound,
  invalidEvalsDir,
  localChanges,
  tasksBehindLock,
} from "../../errors";
import { pc } from "../../utils/colors";
import { initializeLogger } from "../../utils/logger";
import { emitData, outputJson } from "../../utils/output";
import { buildEvalClient, lazyClient } from "./client";
import { type DatasetRun, selectDatasets, TASKS_DIR } from "./datasets";
import {
  type DatasetLock,
  diffTasks,
  ensureGitignore,
  LOCKFILE,
  readLock,
  readState,
  sameTasks,
  type TaskDiff,
  type TasksState,
  writeLock,
  writeState,
} from "./lockfile";
import { packFiles } from "./pack";
import {
  canonicalHashes,
  type DatasetStatus,
  datasetStatus,
  decideRunSync,
  groupName,
  hasLocalChanges,
  isBehindLock,
} from "./sync";
import {
  ensureCachedTask,
  ensureTasksDir,
  installTask,
  removeTask,
} from "./task-cache";
import {
  byteOrder,
  hashLocalTasks,
  hashTaskDir,
  hashTaskFiles,
  isValidName,
  type LocalTasks,
  listTasks,
  MAX_DATASET_NAME,
  MAX_TASK_ARCHIVE_BYTES,
  MAX_TASK_NAME,
  mapLimit,
  type TaskHashes,
  walkTaskFiles,
} from "./tasks";

const logger = initializeLogger();

/** Concurrent task uploads / downloads. */
const TRANSFER_CONCURRENCY = 4;
/** The server's cap on one `missing` request. */
const MISSING_BATCH = 10_000;

export type GetClient = () => Promise<LaminarClient>;

/** A dataset folder as it is on disk. */
export interface LocalDataset {
  /** Folder name, relative to the evals folder. */
  folder: string;
  dir: string;
  lock: DatasetLock | null;
  state: TasksState | null;
  local: LocalTasks;
  /** Hashes of the tasks in `tasks/`, as any machine computes them (`canonicalHashes`). */
  hashes: TaskHashes;
  /** What the tasks in `tasks/` hash to on this disk. */
  diskHashes: TaskHashes;
}

export const readDataset = async (
  evalsDir: string,
  folder: string,
): Promise<LocalDataset> => {
  const dir = path.join(evalsDir, folder);
  const [lock, state, local] = await Promise.all([
    readLock(dir),
    readState(dir),
    listTasks(dir),
  ]);
  const diskHashes = await hashLocalTasks(local);
  return {
    folder,
    dir,
    lock,
    state,
    local,
    hashes: canonicalHashes(diskHashes, state),
    diskHashes,
  };
};

/** The dataset's name in Laminar: the lockfile's, else the folder's. */
const datasetName = (ds: LocalDataset): string => {
  if (ds.lock) return ds.lock.dataset;
  if (!isValidName(ds.folder, MAX_DATASET_NAME)) {
    throw invalidEvalsDir(
      `Folder name "${ds.folder}" can't be a dataset name: use letters, ` +
        `digits, ".", "_" and "-", starting with a letter or digit (at most ` +
        `${MAX_DATASET_NAME} characters). Rename the folder.`,
    );
  }
  return ds.folder;
};

const describeDiff = ({ added, modified, removed }: TaskDiff): string => {
  const parts: string[] = [];
  const list = (names: string[]) =>
    names.slice(0, 5).join(", ") + (names.length > 5 ? ", ..." : "");
  if (modified.length) parts.push(`modified ${list(modified)}`);
  if (added.length) parts.push(`added ${list(added)}`);
  if (removed.length) parts.push(`removed ${list(removed)}`);
  return parts.join("; ") || "no task changes";
};

/** 404s from the dataset routes as `dataset_not_found`; the rest as they are. */
const notFound = (error: unknown, what: string): unknown => {
  const status = (error as { status?: unknown })?.status;
  // A 404 also says that the deployment has no storage for eval datasets.
  if (status === 404 && !/storage/i.test(errorMessage(error))) {
    return datasetNotFound(
      `${what} is not in Laminar (${errorMessage(error)}). ` +
        "Check the name and version (`lmnr-cli eval status`), and that you " +
        "are using the project it was pushed to.",
    );
  }
  return error;
};

const fetchVersion = async (
  client: LaminarClient,
  dataset: string,
  version: number | "latest",
): Promise<DatasetLock> => {
  let found: EvalDatasetVersion;
  try {
    found = await client.evalDatasets.getVersion(dataset, version);
  } catch (error) {
    throw notFound(
      error,
      version === "latest"
        ? `Dataset ${dataset}`
        : `Version ${version} of dataset ${dataset}`,
    );
  }
  return { dataset: found.dataset, version: found.version, tasks: found.tasks };
};

export interface SyncResult {
  /** Tasks downloaded (new or changed), sorted. */
  updated: string[];
  /** Task dirs deleted: not in the version. */
  removed: string[];
  /** Tasks already matching the version. */
  unchanged: number;
}

/**
 * Make `tasks/` match `target`: changed and new tasks come from the cache
 * (downloaded into it first), task dirs not in `target` are deleted, and the
 * sync state records `target`. Hidden dirs and files in `tasks/` stay.
 */
export const syncTasks = async (
  client: LaminarClient,
  ds: LocalDataset,
  target: DatasetLock,
  env?: NodeJS.ProcessEnv,
): Promise<SyncResult> => {
  const invalid = Object.keys(target.tasks).filter(
    (name) => !isValidName(name, MAX_TASK_NAME),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Version ${target.version} of ${target.dataset} has invalid task names: ` +
        invalid.join(", "),
    );
  }
  const tasksDir = path.join(ds.dir, TASKS_DIR);
  await ensureTasksDir(tasksDir);
  const updated = Object.keys(target.tasks)
    .filter((name) => ds.hashes[name] !== target.tasks[name])
    .sort(byteOrder);
  const removed = Object.keys(ds.local.dirs)
    .filter((name) => !(name in target.tasks))
    .sort(byteOrder);
  const download = async (hash: string) => {
    try {
      return await client.evalDatasets.downloadTask(hash);
    } catch (error) {
      throw notFound(error, `Task ${hash} of ${target.dataset}`);
    }
  };
  const cached = await mapLimit(updated, TRANSFER_CONCURRENCY, (name) =>
    ensureCachedTask(target.tasks[name], download, env),
  );
  const disk: TaskHashes = { ...ds.diskHashes };
  for (const [i, name] of updated.entries()) {
    const dest = path.join(tasksDir, name);
    await installTask(cached[i], dest);
    disk[name] = await hashTaskDir(dest);
  }
  for (const name of removed) await removeTask(path.join(tasksDir, name));
  await writeState(ds.dir, target, disk);
  return {
    updated,
    removed,
    unchanged: Object.keys(target.tasks).length - updated.length,
  };
};

const noteGitignore = async (ds: LocalDataset) => {
  if (await ensureGitignore(ds.dir)) {
    const tasks = path.join(ds.dir, TASKS_DIR);
    logger.info(
      `${ds.folder}: added /${TASKS_DIR}/ to its .gitignore (tasks live in ` +
        `Laminar now). If ${TASKS_DIR}/ is committed, untrack it with ` +
        `\`git rm -r --cached ${path.relative(process.cwd(), tasks) || tasks}\`.`,
    );
  }
};

// ---------------------------------------------------------------------------
// eval pull

export interface PullOptions {
  /** Pull this version and pin it; else the lockfile's (latest without one). */
  version?: number | "latest";
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PullResult extends SyncResult {
  dataset: string;
  path: string;
  version: number;
  /** The lockfile's version before the pull; null when it had none. */
  previousVersion: number | null;
  lockUpdated: boolean;
}

/**
 * `eval pull` for `folders`: every dataset is checked for local changes before
 * any is touched, so a refusal leaves everything as it was.
 */
export const pullDatasets = async (
  evalsDir: string,
  folders: string[],
  options: PullOptions,
  getClient: GetClient,
): Promise<PullResult[]> => {
  const plans: { ds: LocalDataset; target: DatasetLock }[] = [];
  for (const folder of folders) {
    const ds = await readDataset(evalsDir, folder);
    const name = datasetName(ds);
    const target =
      options.version === undefined && ds.lock
        ? ds.lock
        : await fetchVersion(
            await getClient(),
            name,
            options.version ?? "latest",
          );
    plans.push({ ds, target });
  }

  const conflicts = plans.filter(
    ({ ds, target }) =>
      !options.force &&
      hasLocalChanges(ds.hashes, ds.state, ds.lock, target.tasks),
  );
  if (conflicts.length > 0) {
    throw localChanges(
      `${TASKS_DIR}/ has changes that eval pull would overwrite:\n` +
        conflicts
          .map(({ ds }) => {
            const base = ds.state ?? ds.lock;
            const what = base
              ? `${describeDiff(diffTasks(base.tasks, ds.hashes))} since v${base.version}`
              : "never synced with Laminar";
            return `  ${ds.folder}: ${what}\n`;
          })
          .join("") +
        "Push them first (`lmnr-cli eval push`), or discard them with " +
        "`lmnr-cli eval pull --force`.",
    );
  }

  const results: PullResult[] = [];
  for (const { ds, target } of plans) {
    const synced = await syncTasks(await getClient(), ds, target, options.env);
    const lockUpdated =
      !ds.lock ||
      ds.lock.dataset !== target.dataset ||
      ds.lock.version !== target.version ||
      !sameTasks(ds.lock.tasks, target.tasks);
    if (lockUpdated) await writeLock(ds.dir, target);
    await noteGitignore(ds);
    results.push({
      dataset: target.dataset,
      path: ds.folder,
      version: target.version,
      previousVersion: ds.lock?.version ?? null,
      lockUpdated,
      ...synced,
    });
  }
  return results;
};

// ---------------------------------------------------------------------------
// eval push

export interface PushOptions {
  message?: string;
  /** Push even when `tasks/` is older than the lockfile's version. */
  force?: boolean;
}

export interface PushResult extends TaskDiff {
  dataset: string;
  path: string;
  version: number;
  /** The version this one builds on (the lockfile's before the push). */
  parentVersion: number | null;
  /** The latest version in Laminar before this push; null when none or up to date. */
  previousLatest: number | null;
  /** Nothing to push: `tasks/` matches the lockfile. */
  upToDate: boolean;
  /** Tasks uploaded (new content); the rest were in Laminar already. */
  uploaded: number;
  tasks: number;
}

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Pack and upload one task. The task is hashed again from the same file list
 * that is packed, so an edit during the push can't upload content under
 * another hash.
 */
const uploadTask = async (
  client: LaminarClient,
  ds: LocalDataset,
  name: string,
  hash: string,
) => {
  const files = await walkTaskFiles(ds.local.dirs[name]);
  if ((await hashTaskFiles(files)) !== ds.diskHashes[name]) {
    throw new Error(
      `${ds.folder}/${TASKS_DIR}/${name} changed during the push; run ` +
        "`lmnr-cli eval push` again.",
    );
  }
  if (ds.diskHashes[name] !== hash) {
    // Unchanged since the pull, but this disk can't hold its file modes
    // (Windows), so packing it here wouldn't reproduce the archive behind `hash`.
    throw new Error(
      `${ds.folder}/${TASKS_DIR}/${name} (${hash}) isn't in this Laminar ` +
        "project, and its file modes can't be reproduced on this machine. " +
        "Push it from macOS or Linux, or edit the task to version it as new.",
    );
  }
  const { archive, index } = await packFiles(files);
  if (archive.length > MAX_TASK_ARCHIVE_BYTES) {
    throw archiveTooLarge(
      `${ds.folder}/${TASKS_DIR}/${name} packs to ${formatMiB(archive.length)}, ` +
        `over the ${formatMiB(MAX_TASK_ARCHIVE_BYTES)} limit per task.`,
    );
  }
  await client.evalDatasets.uploadTask(hash, archive);
  await client.evalDatasets.uploadTaskIndex(hash, { files: index });
};

/** Upload the tasks Laminar doesn't have (by hash). Returns how many. */
const uploadMissing = async (
  client: LaminarClient,
  ds: LocalDataset,
  hashes: string[],
): Promise<number> => {
  const nameOf = new Map<string, string>();
  for (const [name, hash] of Object.entries(ds.hashes)) {
    if (!nameOf.has(hash)) nameOf.set(hash, name);
  }
  const unique = [...new Set(hashes)];
  const missing: string[] = [];
  for (let i = 0; i < unique.length; i += MISSING_BATCH) {
    missing.push(
      ...(await client.evalDatasets.missingTasks(
        unique.slice(i, i + MISSING_BATCH),
      )),
    );
  }
  if (missing.length > 0) {
    logger.info(
      `${ds.folder}: uploading ${missing.length} of ${Object.keys(ds.hashes).length} task(s)`,
    );
  }
  await mapLimit(missing, TRANSFER_CONCURRENCY, async (hash) => {
    const name = nameOf.get(hash);
    if (!name) throw new Error(`The server asked for unknown task ${hash}.`);
    await uploadTask(client, ds, name, hash);
  });
  return missing.length;
};

const validateForPush = (ds: LocalDataset) => {
  if (!ds.local.exists) {
    throw invalidEvalsDir(
      `${path.join(ds.dir, TASKS_DIR)} doesn't exist: nothing to push.`,
    );
  }
  const invalid = Object.keys(ds.local.dirs).filter(
    (name) => !isValidName(name, MAX_TASK_NAME),
  );
  if (invalid.length > 0) {
    throw invalidEvalsDir(
      `${ds.folder}: invalid task folder name(s): ${invalid.join(", ")}. ` +
        'Task names use letters, digits, ".", "_" and "-", starting with a ' +
        `letter or digit (at most ${MAX_TASK_NAME} characters).`,
    );
  }
  datasetName(ds);
};

/**
 * `eval push` for `folders`: each dataset whose `tasks/` differs from its
 * lockfile becomes a new version built on the lockfile's. Every dataset is
 * checked before anything is uploaded.
 */
export const pushDatasets = async (
  evalsDir: string,
  folders: string[],
  options: PushOptions,
  getClient: GetClient,
): Promise<PushResult[]> => {
  const datasets: LocalDataset[] = [];
  for (const folder of folders) {
    const ds = await readDataset(evalsDir, folder);
    validateForPush(ds);
    datasets.push(ds);
  }
  const behind = datasets.filter(
    (ds) =>
      !options.force &&
      isBehindLock(ds.state, ds.lock) &&
      !sameTasks(ds.hashes, ds.lock!.tasks),
  );
  if (behind.length > 0) {
    throw tasksBehindLock(
      `${TASKS_DIR}/ is older than the version ${LOCKFILE} pins, so a push ` +
        "would undo that version's changes:\n" +
        behind
          .map(
            (ds) =>
              `  ${ds.folder}: ${TASKS_DIR}/ was synced to v${ds.state!.version}, ` +
              `${LOCKFILE} pins v${ds.lock!.version}\n`,
          )
          .join("") +
        "Run `lmnr-cli eval pull` first (`--force` drops your edits), or " +
        "`lmnr-cli eval push --force` to push your tasks as they are.",
    );
  }

  const results: PushResult[] = [];
  for (const ds of datasets) {
    const name = datasetName(ds);
    const tasks = Object.keys(ds.hashes).length;
    for (const link of ds.local.symlinks) {
      logger.warn(`${ds.folder}: skipping linked task dir ${link}`);
    }
    if (ds.lock && sameTasks(ds.hashes, ds.lock.tasks)) {
      if (!ds.state || !sameTasks(ds.state.tasks, ds.lock.tasks)) {
        await writeState(ds.dir, ds.lock, ds.diskHashes);
      }
      await noteGitignore(ds);
      results.push({
        dataset: name,
        path: ds.folder,
        version: ds.lock.version,
        parentVersion: ds.lock.version,
        previousLatest: null,
        upToDate: true,
        uploaded: 0,
        tasks,
        added: [],
        modified: [],
        removed: [],
      });
      continue;
    }

    const client = await getClient();
    const uploaded = await uploadMissing(client, ds, Object.values(ds.hashes));
    const parentVersion = ds.lock?.version ?? null;
    const create = () =>
      client.evalDatasets.createVersion(name, {
        parentVersion,
        message: options.message ?? null,
        tasks: ds.hashes,
      });
    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create();
    } catch (error) {
      // A task went missing between the check and the version (e.g. a
      // half-finished upload elsewhere): upload what the server lists, once.
      const missing = (error as { status?: number; missing?: string[] })
        .missing;
      if ((error as { status?: number }).status !== 409 || !missing?.length) {
        throw error;
      }
      await uploadMissing(client, ds, missing);
      created = await create();
    }

    const lock: DatasetLock = {
      dataset: created.dataset,
      version: created.version,
      tasks: ds.hashes,
    };
    await writeLock(ds.dir, lock);
    await writeState(ds.dir, lock, ds.diskHashes);
    await noteGitignore(ds);
    const latest = created.previousLatest;
    if (latest !== null && latest > (parentVersion ?? 0)) {
      const first = (parentVersion ?? 0) + 1;
      const skipped =
        first === latest
          ? `v${first} exists in Laminar and isn't`
          : `v${first}–v${latest} exist in Laminar and aren't`;
      logger.warn(
        `${name}: ${skipped} included in v${created.version}, which builds ` +
          (parentVersion === null
            ? `on nothing (this folder had no ${LOCKFILE}).`
            : `on v${parentVersion}.`),
      );
    }
    results.push({
      dataset: created.dataset,
      path: ds.folder,
      version: created.version,
      parentVersion,
      previousLatest: latest,
      upToDate: false,
      uploaded,
      tasks,
      ...diffTasks(ds.lock?.tasks ?? {}, ds.hashes),
    });
  }
  return results;
};

// ---------------------------------------------------------------------------
// eval status

export const statusDatasets = async (
  evalsDir: string,
  folders: string[],
): Promise<DatasetStatus[]> => {
  const statuses: DatasetStatus[] = [];
  for (const folder of folders) {
    const ds = await readDataset(evalsDir, folder);
    statuses.push(datasetStatus(folder, ds.lock, ds.state, ds.hashes));
  }
  return statuses;
};

export const formatStatus = (statuses: DatasetStatus[]): string => {
  const width = Math.max(...statuses.map((s) => s.path.length));
  const lines: string[] = [];
  for (const s of statuses) {
    const head = `${s.path.padEnd(width)}  ${s.version === null ? "-" : `v${s.version}`}`;
    const counts = `${s.added.length} added, ${s.modified.length} modified, ${s.removed.length} removed`;
    switch (s.state) {
      case "up_to_date":
        lines.push(`${head}  ${pc.green("up to date")} (${s.tasks} tasks)`);
        break;
      case "behind":
        lines.push(
          `${head}  ${pc.yellow("behind")}: ${TASKS_DIR}/ ` +
            (s.tasks === 0 ? "is empty" : `is at v${s.syncedVersion ?? "?"}`) +
            "; `eval pull` (or `eval run`) updates it",
        );
        break;
      case "not_pushed":
        lines.push(
          `${head}  ${pc.yellow("not pushed")} (${s.tasks} tasks); ` +
            "`eval push` creates v1",
        );
        break;
      default:
        lines.push(
          `${head}  ${pc.red("modified")}: ${counts} vs ${LOCKFILE}` +
            "; `eval push` versions them, `eval pull --force` resets",
        );
        for (const name of s.added) lines.push(`    + ${name}`);
        for (const name of s.modified) lines.push(`    ~ ${name}`);
        for (const name of s.removed) lines.push(`    - ${name}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// eval run

/**
 * Before `eval run`: bring each dataset's `tasks/` in line with its lockfile
 * where that loses nothing, and pick its evaluation group: `<dataset> v<N>`
 * when the tasks are the lockfile's version, `<dataset> unversioned` when
 * they were never pushed or have local edits.
 */
export const prepareRunDatasets = async (
  evalsDir: string,
  folders: string[],
  getClient: GetClient,
): Promise<DatasetRun[]> => {
  const runs: DatasetRun[] = [];
  for (const folder of folders) {
    const ds = await readDataset(evalsDir, folder);
    const decision = decideRunSync(ds.lock, ds.state, ds.hashes);
    switch (decision.kind) {
      case "versioned": {
        const { lock } = decision;
        const stale =
          !ds.state ||
          ds.state.version !== lock.version ||
          !sameTasks(ds.state.tasks, lock.tasks);
        if (ds.local.exists && stale) {
          await writeState(ds.dir, lock, ds.diskHashes);
        }
        runs.push({
          path: folder,
          group: groupName(lock.dataset, lock.version),
        });
        break;
      }
      case "pull": {
        const { lock } = decision;
        logger.info(
          `${folder}: ${TASKS_DIR}/ ` +
            (Object.keys(ds.hashes).length === 0
              ? "is empty"
              : `is at v${ds.state?.version}`) +
            `; pulling v${lock.version} (${LOCKFILE})`,
        );
        const synced = await syncTasks(await getClient(), ds, lock);
        logger.info(
          `${folder}: ${synced.updated.length} task(s) downloaded, ` +
            `${synced.removed.length} removed`,
        );
        await noteGitignore(ds);
        runs.push({
          path: folder,
          group: groupName(lock.dataset, lock.version),
        });
        break;
      }
      default:
        if (decision.reason === "not_pushed") {
          if (!ds.local.exists) {
            throw invalidEvalsDir(
              `${path.join(ds.dir, TASKS_DIR)} doesn't exist and there's no ` +
                `${LOCKFILE} to pull: add tasks there, or get the dataset ` +
                "from Laminar with `lmnr-cli eval pull`.",
            );
          }
          runs.push({ path: folder, group: groupName(folder, null) });
        } else {
          const { lock, diff } = decision;
          logger.warn(
            `${folder}: tasks differ from ${LOCKFILE} v${lock.version} ` +
              `(${describeDiff(diff)}); this run isn't linked to a version — ` +
              "`lmnr-cli eval push` to version them or `lmnr-cli eval pull " +
              "--force` to reset.",
          );
          runs.push({ path: folder, group: groupName(lock.dataset, null) });
        }
    }
  }
  return runs;
};

// ---------------------------------------------------------------------------
// Command handlers

interface DatasetOpts extends GlobalOpts {
  dataset?: string[];
}

interface EvalPullOpts extends DatasetOpts {
  version?: number | "latest";
  force?: boolean;
}

interface EvalPushOpts extends DatasetOpts {
  message?: string;
  force?: boolean;
}

/** Commander parser for `--version`: a version number or `latest`. */
export const parseVersion = (raw: string): number | "latest" => {
  if (raw === "latest") return raw;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) {
    throw new InvalidArgumentError("Must be a version number or `latest`.");
  }
  return n;
};

/** `lmnr-cli eval pull [dir]`. */
export const handleEvalPull = async (
  dir: string,
  opts: EvalPullOpts,
): Promise<void> => {
  const evalsDir = path.resolve(dir);
  const folders = await selectDatasets(evalsDir, opts.dataset);
  if (typeof opts.version === "number" && folders.length > 1) {
    throw new InvalidArgumentError(
      "--version <n> pulls one dataset: pass --dataset <name> too.",
    );
  }
  const results = await pullDatasets(
    evalsDir,
    folders,
    { version: opts.version, force: opts.force },
    lazyClient(() => buildEvalClient(opts)),
  );
  if (opts.json) {
    outputJson({ datasets: results });
    return;
  }
  for (const r of results) {
    const changes =
      r.updated.length + r.removed.length === 0
        ? `${TASKS_DIR}/ already matches`
        : `${r.updated.length} task(s) downloaded, ${r.removed.length} removed, ` +
          `${r.unchanged} unchanged`;
    const lock = r.lockUpdated
      ? `; ${LOCKFILE} ${r.previousVersion === null ? "written" : `v${r.previousVersion} → v${r.version}`}`
      : "";
    logger.info(`${r.path}: v${r.version}: ${changes}${lock}`);
  }
};

/** `lmnr-cli eval push [dir]`. */
export const handleEvalPush = async (
  dir: string,
  opts: EvalPushOpts,
): Promise<void> => {
  const evalsDir = path.resolve(dir);
  const folders = await selectDatasets(evalsDir, opts.dataset);
  const results = await pushDatasets(
    evalsDir,
    folders,
    { message: opts.message, force: opts.force },
    lazyClient(() => buildEvalClient(opts)),
  );
  if (opts.json) {
    outputJson({ datasets: results });
    return;
  }
  for (const r of results) {
    if (r.upToDate) {
      logger.info(`${r.path}: up to date with ${LOCKFILE} v${r.version}`);
      continue;
    }
    logger.info(
      `${r.path}: pushed ${r.dataset} v${r.version} (${r.tasks} tasks: ` +
        `${r.added.length} added, ${r.modified.length} modified, ` +
        `${r.removed.length} removed; ${r.uploaded} uploaded); ` +
        `${LOCKFILE} updated — commit it`,
    );
  }
};

/** `lmnr-cli eval status [dir]`: local only, no API calls. */
export const handleEvalStatus = async (
  dir: string,
  opts: DatasetOpts,
): Promise<void> => {
  const evalsDir = path.resolve(dir);
  const statuses = await statusDatasets(
    evalsDir,
    await selectDatasets(evalsDir, opts.dataset),
  );
  if (opts.json) outputJson({ datasets: statuses });
  else emitData(formatStatus(statuses));
};
