import { stat } from "node:fs/promises";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import {
  invalidEvalsDir,
  localEdits,
  pinMoved,
  versionNotFound,
} from "../../errors";
import { pc } from "../../utils/colors";
import { initializeLogger } from "../../utils/logger";
import { emitErr, outputJson } from "../../utils/output";
import { buildEvalClient } from "./client";
import {
  assertNamedTasks,
  dirFilter,
  hashLocalTasks,
  type LocalTasks,
  linkedNames,
  readDatasetState,
  scanTasks,
  type TaskHashes,
  taskFilter,
  writeDatasetState,
} from "./dataset-state";
import {
  datasetApiError,
  forEachLimit,
  installTaskVersion,
  type MovedTask,
  type PlacedVersion,
  type PullPlan,
  type PushPlan,
  planPull,
  planPush,
  planRunPull,
  removeTaskDir,
  shortHash,
  type TaskVersion,
  TRANSFER_CONCURRENCY,
  uploadTaskVersion,
} from "./dataset-sync";
import {
  type DatasetManifest,
  readDatasetToml,
  writeDatasetToml,
} from "./dataset-toml";
import {
  DATASET_TOML,
  discoverDatasetFolders,
  ensureGitignore,
  globToRegExp,
  shortName,
  TASKS_DIR,
} from "./datasets";
import { collectTaskFiles, envFiles } from "./task-hash";

const logger = initializeLogger();

export const DEFAULT_EVALS_DIR = "evals";

export interface DatasetSyncOpts extends GlobalOpts {
  dir?: string;
  task?: string[];
  force?: boolean;
  latest?: boolean;
  dryRun?: boolean;
}

/** A dataset folder with its manifest: `folder` is where, `manifest.name` who. */
export interface LocalDataset {
  folder: string;
  dir: string;
  manifest: DatasetManifest;
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

const selection = (globs: string[] | undefined) =>
  taskFilter((globs ?? []).map(globToRegExp));

const sameHashes = (a: TaskHashes, b: TaskHashes) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => a[k] === b[k]);

/** Each task's latest version in Laminar; null when it has no such dataset. */
const fetchLatest = async (
  client: LaminarClient,
  dataset: string,
): Promise<TaskHashes | null> => {
  try {
    const found = await client.evalDatasets.get(dataset);
    return found
      ? Object.fromEntries(found.tasks.map((t) => [t.id, t.hash]))
      : null;
  } catch (error) {
    throw datasetApiError(error);
  }
};

const missingVersions = async (
  client: LaminarClient,
  dataset: string,
  versions: TaskVersion[],
): Promise<TaskVersion[]> => {
  if (versions.length === 0) return [];
  try {
    return await client.evalDatasets.missingVersions(
      dataset,
      versions.map(({ task, hash }) => ({ task, hash })),
    );
  } catch (error) {
    throw datasetApiError(error);
  }
};

const noManifest = (folder: string) =>
  `${folder} has no ${TASKS_DIR}/${DATASET_TOML}, which names the dataset in ` +
  `Laminar. Create it with:\n[dataset]\nname = "<org>/${folder}"`;

/**
 * Every dataset folder in `evalsDir` with its manifest (null without one).
 * Two folders can't share a dataset name.
 */
export const readDatasetFolders = async (
  evalsDir: string,
): Promise<{ folder: string; manifest: DatasetManifest | null }[]> => {
  const found: { folder: string; manifest: DatasetManifest | null }[] = [];
  const byName = new Map<string, string>();
  for (const folder of await discoverDatasetFolders(evalsDir)) {
    const manifest = await readDatasetToml(path.join(evalsDir, folder));
    const other = manifest && byName.get(manifest.name);
    if (manifest && other) {
      throw invalidEvalsDir(
        `${other} and ${folder} are both dataset ${manifest.name}; give one ` +
          `another [dataset] name in ${TASKS_DIR}/${DATASET_TOML}.`,
      );
    }
    if (manifest) byName.set(manifest.name, folder);
    found.push({ folder, manifest });
  }
  return found;
};

/**
 * The datasets pull / push work on: the named ones (a folder name or a
 * `[dataset] name`; each needs a dataset.toml), else every folder with a
 * dataset.toml, the others skipped with a warning.
 */
const selectDatasets = async (
  evalsDir: string,
  named: string[],
): Promise<LocalDataset[]> => {
  if (!(await isDir(evalsDir))) {
    throw invalidEvalsDir(`Evals folder not found: ${evalsDir}`);
  }
  const folders = await readDatasetFolders(evalsDir);
  const local = (folder: string, manifest: DatasetManifest) => ({
    folder,
    dir: path.join(evalsDir, folder),
    manifest,
  });
  if (named.length > 0) {
    const selected = new Map<string, LocalDataset>();
    for (const name of named) {
      const match = folders.find(
        (f) => f.folder === name || f.manifest?.name === name,
      );
      if (!match) {
        throw invalidEvalsDir(
          `No dataset ${name} in ${evalsDir}: name a dataset folder or its ` +
            `[dataset] name. Datasets: ` +
            (folders.map((f) => f.folder).join(", ") || "none"),
        );
      }
      if (!match.manifest) throw invalidEvalsDir(noManifest(match.folder));
      selected.set(match.folder, local(match.folder, match.manifest));
    }
    return [...selected.values()];
  }
  const datasets: LocalDataset[] = [];
  for (const { folder, manifest } of folders) {
    if (manifest) datasets.push(local(folder, manifest));
    else logger.warn(`Skipping ${noManifest(folder)}`);
  }
  if (datasets.length === 0) {
    throw invalidEvalsDir(
      `No eval datasets in ${evalsDir}: expected <folder>/${TASKS_DIR}/` +
        `${DATASET_TOML} with a [dataset] name, directly inside it.`,
    );
  }
  return datasets;
};

/** The flags that point a suggested command at the same evals folder. */
const dirFlag = (opts: DatasetSyncOpts) =>
  opts.dir && path.resolve(opts.dir) !== path.resolve(DEFAULT_EVALS_DIR)
    ? ` --dir ${opts.dir}`
    : "";

interface DatasetReport {
  dataset: string;
  folder: string;
  added: TaskVersion[];
  changed: { task: string; from: string; to: string }[];
  removed: TaskVersion[];
  /** Push only: versions uploaded (or, dry run, to upload). */
  uploaded?: TaskVersion[];
  skipped?: string;
}

const printReport = (reports: DatasetReport[], verb: string) => {
  for (const r of reports) {
    const title = pc.bold(r.dataset) + pc.dim(` (${r.folder})`);
    if (r.skipped) {
      emitErr(`${title}: skipped (${r.skipped})\n`);
      continue;
    }
    const counts =
      `${r.added.length} added, ${r.changed.length} changed, ` +
      `${r.removed.length} removed`;
    if (r.added.length + r.changed.length + r.removed.length === 0) {
      emitErr(`${title}: up to date\n`);
      continue;
    }
    emitErr(`${title}: ${verb} ${counts}\n`);
    for (const t of r.added) {
      emitErr(`  ${pc.green("+")} ${t.task} ${pc.dim(shortHash(t.hash))}\n`);
    }
    for (const t of r.changed) {
      emitErr(
        `  ${pc.yellow("~")} ${t.task} ` +
          pc.dim(`${shortHash(t.from)} -> ${shortHash(t.to)}`) +
          "\n",
      );
    }
    for (const t of r.removed) emitErr(`  ${pc.red("-")} ${t.task}\n`);
  }
};

const report = (
  reports: DatasetReport[],
  opts: DatasetSyncOpts,
  verb: { done: string; dryRun: string },
) => {
  if (opts.json) {
    outputJson({ dryRun: !!opts.dryRun, datasets: reports });
  } else {
    printReport(reports, opts.dryRun ? verb.dryRun : verb.done);
  }
};

/** `tasks/<dir>` of a task, for messages. */
const taskPath = (folder: string, dir: string) =>
  `${folder}/${TASKS_DIR}/${dir}`;

/**
 * Where each task of a pull goes: its own dir if it has one, else
 * `tasks/<name after the org>`, which must be free.
 */
const placePull = (
  folder: string,
  local: LocalTasks,
  versions: TaskVersion[],
): PlacedVersion[] => {
  const claimed = new Map<string, string>();
  return versions.map(({ task, hash }) => {
    const own = local.dirs[task];
    if (own !== undefined) return { task, hash, dir: own };
    const dir = shortName(task);
    const other = claimed.get(dir);
    if (local.taken.has(dir) || other !== undefined) {
      throw invalidEvalsDir(
        `Can't pull ${task} into ${taskPath(folder, dir)}: ` +
          (other !== undefined
            ? `${other} goes there too.`
            : "that folder holds something else. Rename it and pull again."),
      );
    }
    claimed.set(dir, task);
    return { task, hash, dir };
  });
};

interface PlannedPull {
  dataset: LocalDataset;
  originalState: TaskHashes;
  plan: PullPlan;
  downloads: PlacedVersion[];
  removals: PlacedVersion[];
}

/** Download, swap in and delete what `plan` says, keeping the state in step. */
const applyPull = async (
  client: LaminarClient,
  evalsDir: string,
  { dataset, originalState, plan, downloads, removals }: PlannedPull,
) => {
  await ensureGitignore(evalsDir);
  // On a failure, tasks already written keep their new base: they aren't edits.
  const working = { ...originalState };
  let done = false;
  try {
    await forEachLimit(downloads, TRANSFER_CONCURRENCY, async (version) => {
      await installTaskVersion(
        client,
        dataset.dir,
        dataset.manifest.name,
        version,
      );
      working[version.task] = version.hash;
    });
    for (const { task, dir } of removals) {
      await removeTaskDir(dataset.dir, dir);
      delete working[task];
    }
    if (plan.writePins) {
      await writeDatasetToml(dataset.dir, dataset.manifest, plan.pins);
    }
    done = true;
  } finally {
    const state = done ? plan.state : working;
    if (!sameHashes(state, originalState) || downloads.length > 0) {
      await writeDatasetState(dataset.dir, state);
    }
  }
};

/**
 * `lmnr-cli eval dataset pull [<dataset>...]`: bring `tasks/` to the versions
 * dataset.toml pins (or, with `--latest`, Laminar's latest, written into
 * dataset.toml). Refuses (exit 22) to overwrite or delete edited tasks
 * without `--force`, before writing anything.
 */
export const handleDatasetPull = async (
  named: string[],
  opts: DatasetSyncOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, named);
  const selected = selection(opts.task);
  const client = await buildEvalClient(opts);

  const planned: PlannedPull[] = [];
  const reports: DatasetReport[] = [];
  for (const dataset of datasets) {
    const { folder, dir: datasetDir, manifest } = dataset;
    const local = await scanTasks(datasetDir);
    assertNamedTasks(folder, local);
    const linked = linkedNames(folder, local, selected);
    const managed = (task: string) => selected(task) && !linked.has(task);
    const latest = await fetchLatest(client, manifest.name);
    if (latest === null && (manifest.pins === null || opts.latest)) {
      logger.warn(`Skipping ${manifest.name}: Laminar has no such dataset.`);
      reports.push({
        dataset: manifest.name,
        folder,
        added: [],
        changed: [],
        removed: [],
        skipped: "not in Laminar",
      });
      continue;
    }
    const state = await readDatasetState(datasetDir);
    const hashes = await hashLocalTasks(datasetDir, local, managed);
    const plan = planPull(
      { pins: manifest.pins, state, local: hashes, latest },
      { selected: managed, force: !!opts.force, latest: !!opts.latest },
    );
    planned.push({
      dataset,
      originalState: state,
      plan,
      downloads: placePull(folder, local, [
        ...plan.added,
        ...plan.changed.map(({ task, to }) => ({ task, hash: to })),
      ]),
      removals: plan.removed.map(({ task, hash }) => ({
        task,
        hash,
        dir: local.dirs[task],
      })),
    });
    reports.push({
      dataset: manifest.name,
      folder,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
    });
  }

  const edited = planned.flatMap(({ dataset, plan, downloads, removals }) => {
    const dirs = new Map(
      [...downloads, ...removals].map(({ task, dir }) => [task, dir]),
    );
    return plan.edited.map(
      (task) =>
        `${task} (${taskPath(dataset.folder, dirs.get(task) ?? shortName(task))})`,
    );
  });
  if (edited.length > 0) {
    throw localEdits(
      `Pull would overwrite local edits: ${edited.join(", ")}. Push them ` +
        "first if no one has pushed those tasks since you pulled them; " +
        "otherwise save your edits, pull with --force (which discards " +
        "them), re-apply them and push.",
    );
  }
  for (const { dataset, downloads } of planned) {
    const missing = await missingVersions(
      client,
      dataset.manifest.name,
      downloads,
    );
    if (missing.length > 0) {
      throw versionNotFound(
        `Laminar doesn't have these task versions of ${dataset.manifest.name} ` +
          `that ${DATASET_TOML} pins: ` +
          missing.map((m) => `${m.task}@${shortHash(m.hash)}`).join(", ") +
          ". Were they pushed? `--latest` pulls Laminar's latest instead.",
      );
    }
  }

  if (!opts.dryRun) {
    for (const p of planned) await applyPull(client, evalsDir, p);
  }
  report(reports, opts, { done: "pulled", dryRun: "would pull" });
};

/** The message of a refused push (exit 23). */
const movedMessage = (
  moved: (MovedTask & { folder: string })[],
  opts: DatasetSyncOpts,
): string => {
  const lines = moved.map(
    ({ folder, task, where, to }) =>
      `  ${task}: ` +
      (where === "laminar"
        ? `Laminar's latest version is now ${shortHash(to)}; pull it with ` +
          `\`lmnr-cli eval dataset pull ${folder}${dirFlag(opts)} --latest ` +
          `--task ${task}\``
        : `${DATASET_TOML} now pins ${shortHash(to)}; pull it with ` +
          `\`lmnr-cli eval dataset pull ${folder}${dirFlag(opts)} --task ` +
          `${task}\``),
  );
  return (
    "Push refused: these tasks moved since they were pulled here:\n" +
    `${lines.join("\n")}\n` +
    "Pull, then push again. A task with local edits needs --force to " +
    "pull (which discards them): save your edits, pull with --force, " +
    "re-apply them, then push."
  );
};

interface PlannedPush {
  dataset: LocalDataset;
  local: LocalTasks;
  originalState: TaskHashes;
  plan: PushPlan;
  upload: PlacedVersion[];
}

const applyPush = async (
  client: LaminarClient,
  evalsDir: string,
  { dataset, originalState, plan, upload }: PlannedPush,
  opts: DatasetSyncOpts,
) => {
  const { name } = dataset.manifest;
  await ensureGitignore(evalsDir);
  await forEachLimit(upload, TRANSFER_CONCURRENCY, (version) =>
    uploadTaskVersion(client, dataset.dir, name, version),
  );
  const tasks = [...plan.added, ...plan.changed].map(
    ({ task, hash, base }) => ({ task, hash, base }),
  );
  if (tasks.length > 0) {
    let result: Awaited<ReturnType<typeof client.evalDatasets.push>>;
    try {
      result = await client.evalDatasets.push(name, tasks);
    } catch (error) {
      throw datasetApiError(error);
    }
    if (result.status === "moved") {
      throw pinMoved(
        movedMessage(
          result.moved.map(({ task, latest }) => ({
            folder: dataset.folder,
            task,
            where: "laminar" as const,
            to: latest,
          })),
          opts,
        ),
      );
    }
    if (result.status === "versions_missing") {
      throw new Error(
        `Laminar is missing uploaded versions of ${name}: ` +
          result.missing.map((m) => `${m.task}@${m.hash}`).join(", ") +
          ". Push again.",
      );
    }
  }
  if (plan.writePins) {
    await writeDatasetToml(dataset.dir, dataset.manifest, plan.pins);
  }
  if (!sameHashes(plan.state, originalState)) {
    await writeDatasetState(dataset.dir, plan.state);
  }
};

/** Refuse to upload task files Laminar won't store (`.env*`). */
const assertNoEnvFiles = async (planned: PlannedPush[]) => {
  const found: string[] = [];
  for (const { dataset, local, plan } of planned) {
    for (const { task } of [...plan.added, ...plan.changed]) {
      const dir = local.dirs[task];
      const { files } = await collectTaskFiles(
        path.join(dataset.dir, TASKS_DIR, dir),
      );
      found.push(
        ...envFiles(files).map((f) => `${taskPath(dataset.folder, dir)}/${f}`),
      );
    }
  }
  if (found.length > 0) {
    throw invalidEvalsDir(
      `Not pushing env files, which may hold secrets: ${found.join(", ")}. ` +
        "Delete them, or list them in the task's .gitignore (Harbor then " +
        "leaves them out too); pass secrets as ${VAR}s instead.",
    );
  }
};

/**
 * `lmnr-cli eval dataset push [<dataset>...]`: upload the versions of local
 * tasks Laminar doesn't have, point the dataset at them and pin them in
 * dataset.toml. Refuses (exit 23) tasks whose pin moved since they were
 * pulled here; no override.
 */
export const handleDatasetPush = async (
  named: string[],
  opts: DatasetSyncOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, named);
  const selected = selection(opts.task);
  const client = await buildEvalClient(opts);

  const planned: PlannedPush[] = [];
  for (const dataset of datasets) {
    const { folder, dir: datasetDir, manifest } = dataset;
    const local = await scanTasks(datasetDir);
    assertNamedTasks(folder, local);
    const linked = linkedNames(folder, local, selected);
    const managed = (task: string) => selected(task) && !linked.has(task);
    const state = await readDatasetState(datasetDir);
    const hashes = await hashLocalTasks(datasetDir, local, managed);
    const latest = await fetchLatest(client, manifest.name);
    const plan = planPush(
      { pins: manifest.pins, state, local: hashes, latest },
      managed,
    );
    planned.push({ dataset, local, originalState: state, plan, upload: [] });
  }

  const moved = planned.flatMap(({ dataset, plan }) =>
    plan.moved.map((m) => ({ folder: dataset.folder, ...m })),
  );
  if (moved.length > 0) throw pinMoved(movedMessage(moved, opts));
  await assertNoEnvFiles(planned);

  for (const p of planned) {
    const missing = await missingVersions(client, p.dataset.manifest.name, [
      ...p.plan.added,
      ...p.plan.changed,
    ]);
    p.upload = missing.map(({ task, hash }) => ({
      task,
      hash,
      dir: p.local.dirs[task],
    }));
  }
  if (!opts.dryRun) {
    for (const p of planned) await applyPush(client, evalsDir, p, opts);
  }
  report(
    planned.map(({ dataset, plan, upload }) => ({
      dataset: dataset.manifest.name,
      folder: dataset.folder,
      added: plan.added.map(({ task, hash }) => ({ task, hash })),
      changed: plan.changed.map(({ task, from, hash }) => ({
        task,
        from,
        to: hash,
      })),
      removed: plan.removed,
      uploaded: upload.map(({ task, hash }) => ({ task, hash })),
    })),
    opts,
    { done: "pushed", dryRun: "would push" },
  );
};

/**
 * Before `eval run`: in each dataset whose dataset.toml pins tasks, pull the
 * selected pinned tasks that are missing, and the unedited ones whose pin
 * moved. `taskGlobs` are `eval run --task`'s, Harbor's: they match task dir
 * names (a missing task's dir is its name after the org). Edited tasks run
 * as they are, with a warning. When Laminar can't be reached (or there is no
 * login) but every such task is on disk, the run goes on with a warning.
 */
export const pullRunTasks = async (
  evalsDir: string,
  folders: string[],
  taskGlobs: string[] | undefined,
  opts: GlobalOpts,
  buildClient: (opts: GlobalOpts) => Promise<LaminarClient> = buildEvalClient,
): Promise<void> => {
  const selectedDir = dirFilter((taskGlobs ?? []).map(globToRegExp));
  let client: LaminarClient | undefined;
  let gitignored = false;
  for (const folder of folders) {
    const datasetDir = path.join(evalsDir, folder);
    const manifest = await readDatasetToml(datasetDir);
    const pins = manifest?.pins;
    if (!manifest || !pins) continue;
    if (!gitignored) {
      await ensureGitignore(evalsDir);
      gitignored = true;
    }
    const state = await readDatasetState(datasetDir);
    const local = await scanTasks(datasetDir);
    const dirOf = (task: string) => local.dirs[task] ?? shortName(task);
    const linked = linkedNames(folder, local, (task) =>
      selectedDir(dirOf(task)),
    );
    const managed = (task: string) =>
      selectedDir(dirOf(task)) && !linked.has(task);
    const hashes = await hashLocalTasks(
      datasetDir,
      local,
      (task) => managed(task) && task in pins,
    );
    const plan = planRunPull({ pins, state, local: hashes }, managed);
    for (const { task, hash } of plan.edited) {
      logger.warn(
        `${task} (${taskPath(folder, dirOf(task))}) has local edits; running ` +
          `it as it is (${DATASET_TOML} pins ${shortHash(hash)}).`,
      );
    }
    const pulls: PlacedVersion[] = [];
    for (const { task, hash } of plan.pull) {
      const dir = dirOf(task);
      if (local.dirs[task] === undefined && local.taken.has(dir)) {
        logger.warn(
          `Not pulling ${task}: ${taskPath(folder, dir)} holds another task.`,
        );
      } else pulls.push({ task, hash, dir });
    }
    if (pulls.length === 0) continue;

    const working = { ...state };
    logger.info(
      `Pulling ${pulls.length} task(s) of ${manifest.name} pinned in ` +
        DATASET_TOML,
    );
    try {
      client ??= await buildClient(opts);
      const c = client;
      await forEachLimit(pulls, TRANSFER_CONCURRENCY, async (version) => {
        await installTaskVersion(c, datasetDir, manifest.name, version);
        working[version.task] = version.hash;
      });
    } catch (error) {
      const absent = pulls.filter(({ task }) => hashes[task] === undefined);
      if (absent.length > 0) throw error;
      logger.warn(
        `Could not pull the new pins of ${manifest.name} ` +
          `(${errorMessage(error)}); running the tasks on disk.`,
      );
    } finally {
      if (!sameHashes(working, state)) {
        await writeDatasetState(datasetDir, working);
      }
    }
  }
};
