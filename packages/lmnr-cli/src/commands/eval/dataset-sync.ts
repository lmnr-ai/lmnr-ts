import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import {
  archiveTooLarge,
  datasetNotFound,
  invalidEvalsDir,
  localChanges,
  tasksBehindLock,
} from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { emitData, outputJson } from "../../utils/output";
import { buildEvalClient, lazyClient } from "./client";
import {
  type DatasetRun,
  listDatasetFolders,
  TASKS_DIR,
  taskScope,
} from "./datasets";
import { packFiles } from "./pack";
import {
  canonicalHashes,
  type PullPlan,
  type PushPlan,
  pickTasks,
  planPull,
  planPush,
  type TaskScope,
} from "./sync";
import {
  ensureCachedTask,
  ensureTasksDir,
  installTask,
  removeStaleStaging,
  removeTask,
} from "./task-cache";
import {
  byteOrder,
  chunks,
  HASH,
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
  TASKS_PER_REQUEST,
  type TaskHashes,
  walkTaskFiles,
} from "./tasks";
import {
  ensureGitignore,
  readState,
  readTasksToml,
  type SyncState,
  sameState,
  sameTasks,
  TASKS_TOML,
  writeState,
  writeTasksToml,
} from "./tasks-toml";

const logger = initializeLogger();

/** Concurrent task uploads / downloads. */
const TRANSFER_CONCURRENCY = 4;

export type GetClient = () => Promise<LaminarClient>;

/** A dataset folder as it is on disk. */
export interface LocalDataset {
  /** Folder name, relative to the evals folder: the dataset's name. */
  name: string;
  dir: string;
  /** `tasks.toml`; null when the folder has none. */
  toml: TaskHashes | null;
  state: SyncState;
  local: LocalTasks;
  /** Hashes of the tasks in `tasks/`, as any machine computes them (`canonicalHashes`). */
  hashes: TaskHashes;
  /** What the tasks in `tasks/` hash to on this disk. */
  diskHashes: TaskHashes;
}

/** Read a dataset folder; one that doesn't exist reads as empty. */
export const readDataset = async (
  evalsDir: string,
  name: string,
): Promise<LocalDataset> => {
  const dir = path.join(evalsDir, name);
  const [toml, state, local] = await Promise.all([
    readTasksToml(dir),
    readState(dir),
    listTasks(dir),
  ]);
  const diskHashes = await hashLocalTasks(local);
  return {
    name,
    dir,
    toml,
    state,
    local,
    hashes: canonicalHashes(diskHashes, state),
    diskHashes,
  };
};

export const isValidDatasetName = (name: string) =>
  isValidName(name, MAX_DATASET_NAME);

const assertDatasetName = (name: string) => {
  if (!isValidDatasetName(name)) {
    throw invalidEvalsDir(
      `"${name}" can't be a dataset name: use letters, digits, ".", "_" and ` +
        '"-", starting with a letter or digit (at most ' +
        `${MAX_DATASET_NAME} characters). Rename the dataset folder.`,
    );
  }
};

const assertTaskNames = (dataset: string, names: string[]) => {
  const invalid = names.filter((name) => !isValidName(name, MAX_TASK_NAME));
  if (invalid.length > 0) {
    throw invalidEvalsDir(
      `${dataset}: invalid task folder name(s): ${invalid.join(", ")}. ` +
        'Task names use letters, digits, ".", "_" and "-", starting with a ' +
        `letter or digit (at most ${MAX_TASK_NAME} characters).`,
    );
  }
};

const status = (error: unknown) => (error as { status?: unknown })?.status;

/** A 404 that says the deployment has no storage for eval datasets, not that the dataset is missing. */
const isStorageMissing = (error: unknown) =>
  status(error) === 404 && /need S3 storage/.test(errorMessage(error));

/** 404s from the dataset routes as `dataset_not_found`; the rest as they are. */
const notFound = (error: unknown, what: string): unknown =>
  status(error) === 404 && !isStorageMissing(error)
    ? datasetNotFound(
        `${what} is not in Laminar (${errorMessage(error)}). Check the ` +
          "name, and that you are using the project it was pushed to.",
      )
    : error;

/** The latest version of every task of the dataset in Laminar. */
const fetchLatest = async (
  client: LaminarClient,
  dataset: string,
): Promise<TaskHashes> => {
  let tasks: { name: string; hash: string }[];
  try {
    tasks = await client.evalDatasets.listTasks(dataset);
  } catch (error) {
    throw notFound(error, `Dataset ${dataset}`);
  }
  const invalid = tasks.filter(
    (t) => !isValidName(t.name, MAX_TASK_NAME) || !HASH.test(t.hash),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Laminar returned invalid tasks for ${dataset}: ` +
        invalid.map((t) => t.name).join(", "),
    );
  }
  return Object.fromEntries(tasks.map((t) => [t.name, t.hash]));
};

/**
 * Download task versions (through the cache) and install them as
 * `<tasksDir>/<task>`, replacing what is there. Returns what each installed
 * task hashes to on this disk. Used by pulls and by `eval orchestrate`.
 */
export const fetchTasks = async (
  client: LaminarClient,
  dataset: string,
  tasksDir: string,
  tasks: TaskHashes,
  env?: NodeJS.ProcessEnv,
): Promise<TaskHashes> => {
  assertDatasetName(dataset);
  const names = Object.keys(tasks).sort(byteOrder);
  assertTaskNames(dataset, names);
  await ensureTasksDir(tasksDir);
  const cached = await mapLimit(names, TRANSFER_CONCURRENCY, (name) =>
    ensureCachedTask(
      tasks[name],
      async (hash) => {
        try {
          return await client.evalDatasets.downloadTask(dataset, name, hash);
        } catch (error) {
          throw notFound(error, `Task ${name} (${hash}) of ${dataset}`);
        }
      },
      env,
    ),
  );
  const disk: TaskHashes = {};
  for (const [i, name] of names.entries()) {
    const dest = path.join(tasksDir, name);
    await installTask(cached[i], dest);
    disk[name] = await hashTaskDir(dest);
  }
  return disk;
};

/** Tasks to leave alone while syncing: the run's edited ones. */
type Skip = ReadonlySet<string>;

/**
 * Carry out a pull plan for `ds` (minus `skip`): download added and changed
 * tasks, delete removed ones, and record the sync state. Returns the tasks'
 * hashes afterwards (`LocalDataset.hashes`).
 */
const applyPull = async (
  getClient: GetClient,
  ds: LocalDataset,
  target: TaskHashes,
  plan: PullPlan,
  scope: TaskScope,
  skip: Skip = new Set(),
  env?: NodeJS.ProcessEnv,
): Promise<TaskHashes> => {
  const fetch = [...plan.added, ...plan.changed].filter((n) => !skip.has(n));
  const remove = plan.removed.filter((n) => !skip.has(n));
  const fetchSet = new Set(fetch);
  const tasksDir = path.join(ds.dir, TASKS_DIR);
  if (!ds.local.exists && fetch.length === 0) return ds.hashes;

  await mkdir(ds.dir, { recursive: true });
  const installed =
    fetch.length > 0
      ? await fetchTasks(
          await getClient(),
          ds.name,
          tasksDir,
          pickTasks(target, (n) => fetchSet.has(n)),
          env,
        )
      : {};
  for (const name of remove) await removeTask(path.join(tasksDir, name));

  const hashes = { ...ds.hashes };
  const state: SyncState = {
    tasks: { ...ds.state.tasks },
    localHashes: { ...ds.state.localHashes },
  };
  const synced = (name: string, disk: string) => {
    hashes[name] = target[name];
    state.tasks[name] = target[name];
    if (disk === target[name]) delete state.localHashes[name];
    else state.localHashes[name] = disk;
  };
  for (const name of fetch) synced(name, installed[name]);
  for (const name of plan.unchanged) synced(name, ds.diskHashes[name]);
  for (const name of remove) delete hashes[name];
  // Entries of tasks that are gone from `tasks/`.
  for (const name of Object.keys(state.tasks)) {
    if (scope(name) && !(name in hashes)) {
      delete state.tasks[name];
      delete state.localHashes[name];
    }
  }
  if (!sameState(state, ds.state)) await writeState(ds.dir, state);
  return hashes;
};

const noteGitignore = async (evalsDir: string) => {
  if (await ensureGitignore(evalsDir)) {
    const rel = path.relative(process.cwd(), evalsDir) || ".";
    logger.info(
      `Added */${TASKS_DIR}/ to ${path.join(rel, ".gitignore")}: tasks live ` +
        `in Laminar and each ${TASKS_TOML} pins them. If ${TASKS_DIR}/ ` +
        "folders are committed, untrack them with `git rm -r --cached " +
        `${path.join(rel, "<dataset>", TASKS_DIR)}\`.`,
    );
  }
};

const list = (names: string[]) =>
  names.slice(0, 10).join(", ") + (names.length > 10 ? ", ..." : "");

// ---------------------------------------------------------------------------
// eval dataset pull

export interface PullOptions {
  /** `--task` globs. */
  tasks?: string[];
  force?: boolean;
  /** Pin the latest version of every task in Laminar. */
  latest?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PullResult {
  dataset: string;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  /** Edited tasks among `changed` / `removed` (overwritten: `--force`). */
  localEdits: string[];
  tasksTomlUpdated: boolean;
  dryRun: boolean;
}

interface PullWork {
  ds: LocalDataset;
  toml: TaskHashes;
  tomlUpdated: boolean;
  target: TaskHashes;
  plan: PullPlan;
}

/**
 * `eval dataset pull`: every dataset is planned and checked for local edits
 * before any is touched, so a refusal leaves everything as it was.
 * `datasets` omitted: every dataset folder.
 */
export const pullDatasets = async (
  evalsDir: string,
  datasets: string[] | undefined,
  options: PullOptions,
  getClient: GetClient,
): Promise<PullResult[]> => {
  const named = datasets !== undefined && datasets.length > 0;
  const names = named
    ? [...new Set(datasets)]
    : await listDatasetFolders(evalsDir);
  if (names.length === 0) {
    throw invalidEvalsDir(
      `No datasets in ${evalsDir}. Name one to get it from Laminar: ` +
        "`lmnr-cli eval dataset pull <dataset>`.",
    );
  }
  const scope = taskScope(options.tasks);

  const work: PullWork[] = [];
  for (const name of names) {
    if (named) assertDatasetName(name);
    const ds = await readDataset(evalsDir, name);
    if (!isValidDatasetName(name)) {
      // Never pushed (it can't be): a local-only dataset folder.
      if (ds.toml === null) {
        logger.warn(`${name}: not a valid dataset name; skipped.`);
        continue;
      }
      assertDatasetName(name);
    }
    let toml = ds.toml ?? {};
    if (options.latest || ds.toml === null) {
      let latest: TaskHashes;
      try {
        latest = await fetchLatest(await getClient(), name);
      } catch (error) {
        const missing =
          (error as { code?: unknown }).code === "dataset_not_found";
        if (named || ds.toml !== null || !missing) throw error;
        logger.warn(
          `${name}: not in Laminar yet and has no ${TASKS_TOML}; skipped ` +
            "(`lmnr-cli eval dataset push` creates it).",
        );
        continue;
      }
      toml = { ...toml, ...pickTasks(latest, scope) };
    }
    const target = pickTasks(toml, scope);
    work.push({
      ds,
      toml,
      tomlUpdated: ds.toml === null || !sameTasks(ds.toml, toml),
      target,
      plan: planPull(
        ds.hashes,
        ds.state,
        target,
        scope,
        new Set(ds.local.symlinks),
      ),
    });
  }

  const conflicts = work.filter((w) => w.plan.conflicts.length > 0);
  if (conflicts.length > 0 && !options.force) {
    throw localChanges(
      `${TASKS_DIR}/ has edits the pull would overwrite or delete:\n` +
        conflicts
          .map(({ ds, plan }) => `  ${ds.name}: ${list(plan.conflicts)}\n`)
          .join("") +
        "Push them first (`lmnr-cli eval dataset push`), or discard them " +
        "with `lmnr-cli eval dataset pull --force`. If tasks.toml moved " +
        "past the version an edit started from, push refuses it too: copy " +
        "the edit aside, pull with --force, and re-apply it.",
    );
  }

  const results: PullResult[] = [];
  for (const { ds, toml, tomlUpdated, target, plan } of work) {
    if (!options.dryRun) {
      await applyPull(
        getClient,
        ds,
        target,
        plan,
        scope,
        undefined,
        options.env,
      );
      if (tomlUpdated) {
        await mkdir(ds.dir, { recursive: true });
        await writeTasksToml(ds.dir, toml);
      }
    }
    results.push({
      dataset: ds.name,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
      unchanged: plan.unchanged.length,
      localEdits: plan.conflicts,
      tasksTomlUpdated: tomlUpdated,
      dryRun: !!options.dryRun,
    });
  }
  if (!options.dryRun && results.length > 0) await noteGitignore(evalsDir);
  return results;
};

// ---------------------------------------------------------------------------
// eval dataset push

export interface PushOptions {
  /** `--task` globs. */
  tasks?: string[];
  dryRun?: boolean;
}

export interface PushResult {
  dataset: string;
  added: string[];
  changed: string[];
  /** Dropped from `tasks.toml`; Laminar keeps their versions. */
  removed: string[];
  unchanged: number;
  /** Tasks whose version was uploaded (the rest were in Laminar already). */
  uploaded: string[];
  dryRun: boolean;
}

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Pack and upload one task version. The task is hashed again from the same
 * file list that is packed, so an edit during the push can't upload content
 * under another hash.
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
      `${ds.name}/${TASKS_DIR}/${name} changed during the push; run ` +
        "`lmnr-cli eval dataset push` again.",
    );
  }
  if (ds.diskHashes[name] !== hash) {
    // Unchanged since the pull, but this disk can't hold its file modes
    // (Windows), so packing it here wouldn't reproduce the archive behind `hash`.
    throw new Error(
      `${ds.name}/${TASKS_DIR}/${name} (${hash}) isn't in this Laminar ` +
        "project, and its file modes can't be reproduced on this machine. " +
        "Push it from macOS or Linux, or edit the task to version it as new.",
    );
  }
  const { archive, index } = await packFiles(files);
  if (archive.length > MAX_TASK_ARCHIVE_BYTES) {
    throw archiveTooLarge(
      `${ds.name}/${TASKS_DIR}/${name} packs to ${formatMiB(archive.length)}, ` +
        `over the ${formatMiB(MAX_TASK_ARCHIVE_BYTES)} limit per task.`,
    );
  }
  await client.evalDatasets.uploadTask(ds.name, name, hash, archive);
  await client.evalDatasets.uploadTaskIndex(ds.name, name, hash, {
    files: index,
  });
};

/** Upload the task versions Laminar doesn't have. Returns their tasks. */
const uploadMissing = async (
  client: LaminarClient,
  ds: LocalDataset,
  tasks: TaskHashes,
): Promise<string[]> => {
  const missing: string[] = [];
  for (const batch of chunks(Object.keys(tasks), TASKS_PER_REQUEST)) {
    const names = new Set(batch);
    missing.push(
      ...(await client.evalDatasets.missingTasks(
        ds.name,
        pickTasks(tasks, (n) => names.has(n)),
      )),
    );
  }
  const unknown = missing.filter((name) => !(name in tasks));
  if (unknown.length > 0) {
    throw new Error(`Laminar asked for unknown tasks: ${list(unknown)}`);
  }
  if (missing.length > 0) {
    logger.info(`${ds.name}: uploading ${missing.length} task version(s)`);
  }
  await mapLimit(missing, TRANSFER_CONCURRENCY, (name) =>
    uploadTask(client, ds, name, tasks[name]),
  );
  return missing;
};

/** The version a pushed task's change started from: as pulled / pushed here, else as pinned. */
const baseOf = (ds: LocalDataset, toml: TaskHashes, name: string) =>
  ds.state.tasks[name] ?? toml[name] ?? null;

const movedError = (moved: { name: string; tasks: string[] }[]) =>
  tasksBehindLock(
    "Newer versions of these tasks were pushed to Laminar since they were " +
      "pulled here, so pushing them would replace those versions:\n" +
      moved.map(({ name, tasks }) => `  ${name}: ${list(tasks)}\n`).join("") +
      "Copy any edits aside, run `lmnr-cli eval dataset pull <dataset> " +
      "--latest --force --task <task>`, re-apply them on top, then push.",
  );

/**
 * Make the versions their tasks' latest; a 409's missing ones are uploaded
 * and retried once. The server refuses (409 `moved`) when another version
 * became a task's latest since its base, also between our check and here.
 */
const pushVersions = async (
  client: LaminarClient,
  ds: LocalDataset,
  toml: TaskHashes,
  tasks: TaskHashes,
): Promise<string[]> => {
  const uploaded = await uploadMissing(client, ds, tasks);
  for (const batch of chunks(Object.keys(tasks), TASKS_PER_REQUEST)) {
    const names = new Set(batch);
    const body = pickTasks(tasks, (n) => names.has(n));
    const base = Object.fromEntries(
      batch.map((name) => [name, baseOf(ds, toml, name)]),
    );
    const push = async () => {
      try {
        await client.evalDatasets.pushTasks(ds.name, body, base);
      } catch (error) {
        const moved = (error as { moved?: string[] }).moved;
        if (status(error) === 409 && moved?.length) {
          throw movedError([{ name: ds.name, tasks: moved }]);
        }
        throw error;
      }
    };
    try {
      await push();
    } catch (error) {
      // A version went missing between the check and the push (e.g. a
      // half-finished upload elsewhere): upload what the server lists, once.
      const missing = (error as { missing?: string[] }).missing;
      if (status(error) !== 409 || !missing?.length) throw error;
      uploaded.push(
        ...(await uploadMissing(
          client,
          ds,
          pickTasks(body, (n) => missing.includes(n)),
        )),
      );
      await push();
    }
  }
  return [...new Set(uploaded)].sort(byteOrder);
};

const pushedTasks = (ds: LocalDataset, plan: PushPlan): TaskHashes => {
  const names = new Set([...plan.added, ...plan.changed]);
  return pickTasks(ds.hashes, (n) => names.has(n));
};

/**
 * Pushed tasks whose latest version in Laminar is neither what they were
 * pulled here as (else what `tasks.toml` pins) nor what is being pushed: a
 * teammate pushed since, and pushing would make their version not latest. A
 * task Laminar has that was never pulled here counts too.
 */
const movedInLaminar = async (
  getClient: GetClient,
  work: { ds: LocalDataset; toml: TaskHashes; plan: PushPlan }[],
): Promise<{ name: string; tasks: string[] }[]> => {
  const moved: { name: string; tasks: string[] }[] = [];
  for (const { ds, toml, plan } of work) {
    const pushed = pushedTasks(ds, plan);
    if (Object.keys(pushed).length === 0) continue;
    let latest: TaskHashes;
    try {
      latest = await fetchLatest(await getClient(), ds.name);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "dataset_not_found") {
        throw error;
      }
      continue;
    }
    const tasks = Object.entries(pushed)
      .filter(([name, hash]) => {
        const current = latest[name];
        return (
          current !== undefined &&
          current !== hash &&
          current !== baseOf(ds, toml, name)
        );
      })
      .map(([name]) => name)
      .sort(byteOrder);
    if (tasks.length > 0) moved.push({ name: ds.name, tasks });
  }
  return moved;
};

/**
 * `eval dataset push`: every dataset is checked before anything is uploaded.
 * `datasets` omitted: every dataset folder with a `tasks/` dir.
 */
export const pushDatasets = async (
  evalsDir: string,
  datasets: string[] | undefined,
  options: PushOptions,
  getClient: GetClient,
): Promise<PushResult[]> => {
  const named = datasets !== undefined && datasets.length > 0;
  const names = named
    ? [...new Set(datasets)]
    : await listDatasetFolders(evalsDir);
  const scope = taskScope(options.tasks);

  const work: { ds: LocalDataset; toml: TaskHashes; plan: PushPlan }[] = [];
  for (const name of names) {
    if (named) assertDatasetName(name);
    const ds = await readDataset(evalsDir, name);
    if (!ds.local.exists) {
      if (!named) continue;
      throw invalidEvalsDir(
        `${path.join(ds.dir, TASKS_DIR)} doesn't exist: nothing to push.`,
      );
    }
    if (!named && !isValidDatasetName(name)) {
      logger.warn(`${name}: not a valid dataset name; skipped.`);
      continue;
    }
    const toml = ds.toml ?? {};
    const planned = planPush(ds.hashes, ds.state, toml, scope);
    // A task dir replaced by a link is skipped, not deleted: its pin stays.
    const plan = {
      ...planned,
      removed: planned.removed.filter((n) => !ds.local.symlinks.includes(n)),
    };
    assertTaskNames(name, [...plan.added, ...plan.changed]);
    for (const link of ds.local.symlinks) {
      logger.warn(`${name}: skipping linked task dir ${link}`);
    }
    work.push({ ds, toml, plan });
  }
  if (work.length === 0) {
    throw invalidEvalsDir(
      `No dataset in ${evalsDir} has a ${TASKS_DIR}/ folder: nothing to push.`,
    );
  }

  const behind = work.filter((w) => w.plan.behind.length > 0);
  if (behind.length > 0) {
    throw tasksBehindLock(
      `${TASKS_TOML} pins other versions of tasks that are unedited here ` +
        `(it changed since they were pulled), so pushing them would undo ` +
        "those versions:\n" +
        behind
          .map(({ ds, plan }) => `  ${ds.name}: ${list(plan.behind)}\n`)
          .join("") +
        "Run `lmnr-cli eval dataset pull` first.",
    );
  }
  const diverged = work.filter((w) => w.plan.diverged.length > 0);
  if (diverged.length > 0) {
    throw tasksBehindLock(
      `${TASKS_TOML} pins newer versions of tasks edited here than the ones ` +
        "the edits started from, so pushing them would drop those versions:\n" +
        diverged
          .map(({ ds, plan }) => `  ${ds.name}: ${list(plan.diverged)}\n`)
          .join("") +
        "Copy your edits aside, run `lmnr-cli eval dataset pull --force " +
        "--task <task>`, re-apply them on top, then push.",
    );
  }

  const moved = await movedInLaminar(getClient, work);
  if (moved.length > 0) throw movedError(moved);

  const results: PushResult[] = [];
  for (const { ds, toml, plan } of work) {
    const pushed = pushedTasks(ds, plan);
    const result: PushResult = {
      dataset: ds.name,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
      unchanged: plan.unchanged.length,
      uploaded: [],
      dryRun: !!options.dryRun,
    };
    results.push(result);
    if (options.dryRun) continue;

    if (Object.keys(pushed).length > 0) {
      result.uploaded = await pushVersions(await getClient(), ds, toml, pushed);
    }
    const nextToml = { ...toml, ...pushed };
    for (const name of plan.removed) delete nextToml[name];
    if (ds.toml === null || !sameTasks(toml, nextToml)) {
      await writeTasksToml(ds.dir, nextToml);
    }
    // Every task in scope that now matches its pin is synced.
    const state: SyncState = {
      tasks: { ...ds.state.tasks },
      localHashes: { ...ds.state.localHashes },
    };
    for (const name of [...Object.keys(pushed), ...plan.unchanged]) {
      state.tasks[name] = ds.hashes[name];
      if (ds.diskHashes[name] === ds.hashes[name]) {
        delete state.localHashes[name];
      } else {
        state.localHashes[name] = ds.diskHashes[name];
      }
    }
    for (const name of plan.removed) {
      delete state.tasks[name];
      delete state.localHashes[name];
    }
    if (!sameState(state, ds.state)) await writeState(ds.dir, state);
  }
  if (!options.dryRun) await noteGitignore(evalsDir);
  return results;
};

// ---------------------------------------------------------------------------
// eval run

/**
 * Before `eval run`: bring each dataset's `tasks/` in line with its
 * `tasks.toml` where that loses nothing (missing tasks, and unedited tasks
 * whose pin moved, are pulled; edited ones run as they are, with a warning),
 * and hash the tasks the run includes for the Harbor plugin.
 */
export const prepareRunDatasets = async (
  evalsDir: string,
  folders: string[],
  taskGlobs: string[] | undefined,
  getClient: GetClient,
): Promise<DatasetRun[]> => {
  const scope = taskScope(taskGlobs);
  const runs: DatasetRun[] = [];
  let synced = false;
  for (const folder of folders) {
    // Harbor would run a staged copy an interrupted pull left behind.
    await removeStaleStaging(path.join(evalsDir, folder, TASKS_DIR));
    const ds = await readDataset(evalsDir, folder);
    if (ds.toml === null) {
      if (!ds.local.exists) {
        throw invalidEvalsDir(
          `${path.join(ds.dir, TASKS_DIR)} doesn't exist and there's no ` +
            `${TASKS_TOML} to pull: add tasks there, or get the dataset ` +
            `from Laminar with \`lmnr-cli eval dataset pull ${folder}\`.`,
        );
      }
      runs.push({ path: folder, taskHashes: pickTasks(ds.hashes, scope) });
      continue;
    }
    const target = pickTasks(ds.toml, scope);
    const plan = planPull(
      ds.hashes,
      ds.state,
      target,
      scope,
      new Set(ds.local.symlinks),
    );
    const skip = new Set(plan.conflicts);
    if (skip.size > 0) {
      logger.warn(
        `${folder}: ${list(plan.conflicts)} edited locally and not what ` +
          `${TASKS_TOML} pins; running them as they are (\`lmnr-cli eval ` +
          "dataset push` versions them, `lmnr-cli eval dataset pull --force` " +
          "resets them).",
      );
    }
    const fetch = [...plan.added, ...plan.changed].filter((n) => !skip.has(n));
    const remove = plan.removed.filter((n) => !skip.has(n));
    if (fetch.length + remove.length > 0) {
      logger.info(
        `${folder}: pulling ${fetch.length} task(s) ${TASKS_TOML} pins` +
          (remove.length > 0
            ? `, removing ${remove.length} it no longer pins`
            : ""),
      );
      synced = true;
    }
    const hashes = await applyPull(getClient, ds, target, plan, scope, skip);
    runs.push({ path: folder, taskHashes: pickTasks(hashes, scope) });
  }
  if (synced) await noteGitignore(evalsDir);
  return runs;
};

// ---------------------------------------------------------------------------
// Command handlers

interface DatasetSyncOpts extends GlobalOpts {
  dir?: string;
  task?: string[];
  dryRun?: boolean;
}

interface EvalPullOpts extends DatasetSyncOpts {
  force?: boolean;
  latest?: boolean;
}

const changeLines = (
  r: { added: string[]; changed: string[]; removed: string[] },
  edited: string[] = [],
) =>
  [
    ...r.added.map((n) => `  + ${n}`),
    ...r.changed.map(
      (n) => `  ~ ${n}${edited.includes(n) ? " (local edits)" : ""}`,
    ),
    ...r.removed.map(
      (n) => `  - ${n}${edited.includes(n) ? " (local edits)" : ""}`,
    ),
  ].map((line) => `${line}\n`);

const counts = (r: {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
}) =>
  `${r.added.length} added, ${r.changed.length} changed, ` +
  `${r.removed.length} removed, ${r.unchanged} unchanged`;

/** Plain-text plan of a `--dry-run`. */
export const formatPullPlan = (results: PullResult[]): string =>
  results
    .map(
      (r) =>
        `${r.dataset}: ${counts(r)}` +
        (r.tasksTomlUpdated ? `; ${TASKS_TOML} would be updated` : "") +
        "\n" +
        changeLines(r, r.localEdits).join(""),
    )
    .join("");

export const formatPushPlan = (results: PushResult[]): string =>
  results
    .map((r) => `${r.dataset}: ${counts(r)}\n${changeLines(r).join("")}`)
    .join("");

const datasetArgs = (datasets: string[]) =>
  datasets.length > 0 ? datasets : undefined;

/** `lmnr-cli eval dataset pull [datasets...]`. */
export const handleEvalDatasetPull = async (
  datasets: string[],
  opts: EvalPullOpts,
): Promise<void> => {
  const results = await pullDatasets(
    path.resolve(opts.dir ?? "evals"),
    datasetArgs(datasets),
    {
      tasks: opts.task,
      force: opts.force,
      latest: opts.latest,
      dryRun: opts.dryRun,
    },
    lazyClient(() => buildEvalClient(opts)),
  );
  if (opts.json) {
    outputJson({ datasets: results });
  } else if (opts.dryRun) {
    emitData(formatPullPlan(results));
  } else {
    for (const r of results) {
      logger.info(
        `${r.dataset}: ${counts(r)}` +
          (r.tasksTomlUpdated ? `; ${TASKS_TOML} updated, commit it` : ""),
      );
    }
  }
};

/** `lmnr-cli eval dataset push [datasets...]`. */
export const handleEvalDatasetPush = async (
  datasets: string[],
  opts: DatasetSyncOpts,
): Promise<void> => {
  const results = await pushDatasets(
    path.resolve(opts.dir ?? "evals"),
    datasetArgs(datasets),
    { tasks: opts.task, dryRun: opts.dryRun },
    lazyClient(() => buildEvalClient(opts)),
  );
  if (opts.json) {
    outputJson({ datasets: results });
  } else if (opts.dryRun) {
    emitData(formatPushPlan(results));
  } else {
    for (const r of results) {
      const changes = r.added.length + r.changed.length + r.removed.length;
      logger.info(
        changes === 0
          ? `${r.dataset}: up to date with ${TASKS_TOML}`
          : `${r.dataset}: ${counts(r)} (${r.uploaded.length} uploaded); ` +
              `${TASKS_TOML} updated, commit it`,
      );
    }
  }
};
