import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import {
  datasetNotFound,
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
  hashLocalTasks,
  listTaskDirs,
  readDatasetState,
  type TaskHashes,
  taskFilter,
  unlinkedTasks,
  writeDatasetState,
} from "./dataset-state";
import {
  datasetApiError,
  forEachLimit,
  installTaskVersion,
  type MovedTask,
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
  discoverDatasetFolders,
  ensureGitignore,
  globToRegExp,
  isValidDatasetName,
} from "./datasets";
import { readTasksToml, writeTasksToml } from "./tasks-toml";

const logger = initializeLogger();

export const DEFAULT_EVALS_DIR = "evals";

export interface DatasetSyncOpts extends GlobalOpts {
  dir?: string;
  task?: string[];
  force?: boolean;
  latest?: boolean;
  dryRun?: boolean;
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
    return await client.evalDatasets.missingVersions(dataset, versions);
  } catch (error) {
    throw datasetApiError(error);
  }
};

/**
 * The datasets pull / push work on: the named ones (each must be a valid
 * name), else every dataset folder in `evalsDir`, skipping invalid names
 * with a warning.
 */
const selectDatasets = async (
  evalsDir: string,
  named: string[],
): Promise<string[]> => {
  if (named.length > 0) {
    const invalid = named.filter((name) => !isValidDatasetName(name));
    if (invalid.length > 0) {
      throw invalidEvalsDir(
        `Invalid dataset name: ${invalid.join(", ")}. Names start with a ` +
          "letter or digit and hold only letters, digits, '.', '_' and '-' " +
          "(at most 100 bytes).",
      );
    }
    return [...new Set(named)];
  }
  if (!(await isDir(evalsDir))) {
    throw invalidEvalsDir(`Evals folder not found: ${evalsDir}`);
  }
  const datasets: string[] = [];
  for (const folder of await discoverDatasetFolders(evalsDir)) {
    if (isValidDatasetName(folder)) datasets.push(folder);
    else {
      logger.warn(
        `Skipping ${folder}: not a valid dataset name (letters, digits, ` +
          "'.', '_' and '-', starting with a letter or digit).",
      );
    }
  }
  if (datasets.length === 0) {
    throw invalidEvalsDir(
      `No datasets in ${evalsDir}: expected <dataset>/harbor.yaml, ` +
        "<dataset>/tasks.toml or <dataset>/tasks/ directly inside it.",
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
  added: TaskVersion[];
  changed: { task: string; from: string; to: string }[];
  removed: TaskVersion[];
  /** Push only: versions uploaded (or, dry run, to upload). */
  uploaded?: TaskVersion[];
  skipped?: string;
}

const printReport = (reports: DatasetReport[], verb: string) => {
  for (const r of reports) {
    if (r.skipped) {
      emitErr(`${pc.bold(r.dataset)}: skipped (${r.skipped})\n`);
      continue;
    }
    const counts =
      `${r.added.length} added, ${r.changed.length} changed, ` +
      `${r.removed.length} removed`;
    if (r.added.length + r.changed.length + r.removed.length === 0) {
      emitErr(`${pc.bold(r.dataset)}: up to date\n`);
      continue;
    }
    emitErr(`${pc.bold(r.dataset)}: ${verb} ${counts}\n`);
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

interface PlannedPull {
  dataset: string;
  datasetDir: string;
  originalState: TaskHashes;
  plan: PullPlan;
}

/** Download, swap in and delete what `plan` says, keeping the state in step. */
const applyPull = async (
  client: LaminarClient,
  evalsDir: string,
  { dataset, datasetDir, originalState, plan }: PlannedPull,
) => {
  await mkdir(datasetDir, { recursive: true });
  await ensureGitignore(evalsDir);
  const downloads = [
    ...plan.added,
    ...plan.changed.map(({ task, to }) => ({ task, hash: to })),
  ];
  // On a failure, tasks already written keep their new base: they aren't edits.
  const working = { ...originalState };
  let done = false;
  try {
    await forEachLimit(downloads, TRANSFER_CONCURRENCY, async (version) => {
      await installTaskVersion(client, datasetDir, dataset, version);
      working[version.task] = version.hash;
    });
    for (const { task } of plan.removed) {
      await removeTaskDir(datasetDir, task);
      delete working[task];
    }
    if (plan.writePins) await writeTasksToml(datasetDir, plan.pins);
    done = true;
  } finally {
    const state = done ? plan.state : working;
    if (!sameHashes(state, originalState) || downloads.length > 0) {
      await writeDatasetState(datasetDir, state);
    }
  }
};

/**
 * `lmnr-cli eval dataset pull [<dataset>...]`: bring `tasks/` to the versions
 * tasks.toml pins (or, with `--latest`, Laminar's latest, written into
 * tasks.toml). Refuses (exit 22) to overwrite or delete edited tasks without
 * `--force`, before writing anything.
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
    const datasetDir = path.join(evalsDir, dataset);
    const exists = await isDir(datasetDir);
    const pins = exists ? await readTasksToml(datasetDir) : null;
    const latest = await fetchLatest(client, dataset);
    if (latest === null && (pins === null || opts.latest)) {
      if (!exists) {
        throw datasetNotFound(
          `Laminar has no dataset ${dataset}, and there is no ${datasetDir}.`,
        );
      }
      logger.warn(
        `Skipping ${dataset}: Laminar has no such dataset` +
          (pins === null ? " and it has no tasks.toml." : "."),
      );
      reports.push({
        dataset,
        added: [],
        changed: [],
        removed: [],
        skipped: "not in Laminar",
      });
      continue;
    }
    const state = await readDatasetState(datasetDir);
    const managed = await unlinkedTasks(datasetDir, dataset, selected);
    const local = await hashLocalTasks(datasetDir, managed);
    const plan = planPull(
      { pins, state, local, latest },
      { selected: managed, force: !!opts.force, latest: !!opts.latest },
    );
    planned.push({ dataset, datasetDir, originalState: state, plan });
    reports.push({
      dataset,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
    });
  }

  const edited = planned.flatMap(({ dataset, plan }) =>
    plan.edited.map((task) => `${dataset}/${task}`),
  );
  if (edited.length > 0) {
    throw localEdits(
      `Pull would overwrite local edits in tasks/: ${edited.join(", ")}. ` +
        "Push them first if no one has pushed those tasks since you " +
        "pulled them; otherwise save your edits, pull with --force (which " +
        "discards them), re-apply them and push.",
    );
  }
  for (const { dataset, plan } of planned) {
    const wanted = [
      ...plan.added,
      ...plan.changed.map(({ task, to }) => ({ task, hash: to })),
    ];
    const missing = await missingVersions(client, dataset, wanted);
    if (missing.length > 0) {
      throw versionNotFound(
        `Laminar doesn't have these task versions of ${dataset} that ` +
          "tasks.toml pins: " +
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
  moved: (MovedTask & { dataset: string })[],
  opts: DatasetSyncOpts,
): string => {
  const lines = moved.map(
    ({ dataset, task, where, to }) =>
      `  ${dataset}/${task}: ` +
      (where === "laminar"
        ? `Laminar's latest version is now ${shortHash(to)}; pull it with ` +
          `\`lmnr-cli eval dataset pull ${dataset}${dirFlag(opts)} --latest ` +
          `--task ${task}\``
        : `tasks.toml now pins ${shortHash(to)}; pull it with ` +
          `\`lmnr-cli eval dataset pull ${dataset}${dirFlag(opts)} --task ` +
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
  dataset: string;
  datasetDir: string;
  originalState: TaskHashes;
  plan: PushPlan;
  upload: TaskVersion[];
}

const applyPush = async (
  client: LaminarClient,
  evalsDir: string,
  { dataset, datasetDir, originalState, plan, upload }: PlannedPush,
  opts: DatasetSyncOpts,
) => {
  await ensureGitignore(evalsDir);
  await forEachLimit(upload, TRANSFER_CONCURRENCY, (version) =>
    uploadTaskVersion(client, datasetDir, dataset, version),
  );
  const tasks = [...plan.added, ...plan.changed].map(
    ({ task, hash, base }) => ({ task, hash, base }),
  );
  if (tasks.length > 0) {
    let result: Awaited<ReturnType<typeof client.evalDatasets.push>>;
    try {
      result = await client.evalDatasets.push(dataset, tasks);
    } catch (error) {
      throw datasetApiError(error);
    }
    if (result.status === "moved") {
      throw pinMoved(
        movedMessage(
          result.moved.map(({ task, latest }) => ({
            dataset,
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
        `Laminar is missing uploaded versions of ${dataset}: ` +
          result.missing.map((m) => `${m.task}@${m.hash}`).join(", ") +
          ". Push again.",
      );
    }
  }
  if (plan.writePins) await writeTasksToml(datasetDir, plan.pins);
  if (!sameHashes(plan.state, originalState)) {
    await writeDatasetState(datasetDir, plan.state);
  }
};

/**
 * `lmnr-cli eval dataset push [<dataset>...]`: upload the versions of local
 * tasks Laminar doesn't have, point the dataset at them and pin them in
 * tasks.toml. Refuses (exit 23) tasks whose pin moved since they were pulled
 * here; no override.
 */
export const handleDatasetPush = async (
  named: string[],
  opts: DatasetSyncOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, named);
  for (const dataset of datasets) {
    if (!(await isDir(path.join(evalsDir, dataset)))) {
      throw invalidEvalsDir(
        `No dataset folder ${path.join(evalsDir, dataset)}`,
      );
    }
  }
  const selected = selection(opts.task);
  const client = await buildEvalClient(opts);

  const planned: PlannedPush[] = [];
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const { invalid } = await listTaskDirs(datasetDir);
    for (const name of invalid.filter(selected)) {
      logger.warn(
        `Not pushing ${dataset}/tasks/${name}: not a valid task name ` +
          "(letters, digits, '.', '_' and '-', starting with a letter or digit).",
      );
    }
    const pins = await readTasksToml(datasetDir);
    const state = await readDatasetState(datasetDir);
    const managed = await unlinkedTasks(datasetDir, dataset, selected);
    const local = await hashLocalTasks(datasetDir, managed);
    const latest = await fetchLatest(client, dataset);
    const plan = planPush({ pins, state, local, latest }, managed);
    planned.push({
      dataset,
      datasetDir,
      originalState: state,
      plan,
      upload: [],
    });
  }

  const moved = planned.flatMap(({ dataset, plan }) =>
    plan.moved.map((m) => ({ dataset, ...m })),
  );
  if (moved.length > 0) throw pinMoved(movedMessage(moved, opts));

  for (const p of planned) {
    p.upload = await missingVersions(client, p.dataset, [
      ...p.plan.added,
      ...p.plan.changed,
    ]);
  }
  if (!opts.dryRun) {
    for (const p of planned) await applyPush(client, evalsDir, p, opts);
  }
  report(
    planned.map(({ dataset, plan, upload }) => ({
      dataset,
      added: plan.added.map(({ task, hash }) => ({ task, hash })),
      changed: plan.changed.map(({ task, from, hash }) => ({
        task,
        from,
        to: hash,
      })),
      removed: plan.removed,
      uploaded: upload,
    })),
    opts,
    { done: "pushed", dryRun: "would push" },
  );
};

/**
 * Before `eval run`: in each dataset with a tasks.toml, pull the selected
 * pinned tasks that are missing, and the unedited ones whose pin moved.
 * Edited tasks run as they are, with a warning. When Laminar can't be
 * reached (or there is no login) but every such task is on disk, the run
 * goes on with a warning.
 */
export const pullRunTasks = async (
  evalsDir: string,
  datasets: string[],
  taskGlobs: string[] | undefined,
  opts: GlobalOpts,
  buildClient: (opts: GlobalOpts) => Promise<LaminarClient> = buildEvalClient,
): Promise<void> => {
  const selected = selection(taskGlobs);
  let client: LaminarClient | undefined;
  let gitignored = false;
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const pins = await readTasksToml(datasetDir);
    if (pins === null) continue;
    if (!gitignored) {
      await ensureGitignore(evalsDir);
      gitignored = true;
    }
    const state = await readDatasetState(datasetDir);
    const managed = await unlinkedTasks(datasetDir, dataset, selected);
    const local = await hashLocalTasks(
      datasetDir,
      (task) => managed(task) && task in pins,
    );
    const plan = planRunPull({ pins, state, local }, managed);
    for (const { task, hash } of plan.edited) {
      logger.warn(
        `${dataset}/${task} has local edits; running it as it is ` +
          `(tasks.toml pins ${shortHash(hash)}).`,
      );
    }
    if (plan.pull.length === 0) continue;

    const working = { ...state };
    logger.info(
      `Pulling ${plan.pull.length} task(s) of ${dataset} pinned in tasks.toml`,
    );
    try {
      if (!isValidDatasetName(dataset)) {
        throw invalidEvalsDir(
          `${dataset} is not a valid dataset name, so its pinned tasks ` +
            "can't be pulled from Laminar.",
        );
      }
      client ??= await buildClient(opts);
      const c = client;
      await forEachLimit(plan.pull, TRANSFER_CONCURRENCY, async (version) => {
        await installTaskVersion(c, datasetDir, dataset, version);
        working[version.task] = version.hash;
      });
    } catch (error) {
      const absent = plan.pull.filter(({ task }) => local[task] === undefined);
      if (absent.length > 0) throw error;
      logger.warn(
        `Could not pull the new pins of ${dataset} ` +
          `(${errorMessage(error)}); running the tasks on disk.`,
      );
    } finally {
      if (!sameHashes(working, state)) {
        await writeDatasetState(datasetDir, working);
      }
    }
  }
};
