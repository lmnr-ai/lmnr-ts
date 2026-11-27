import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { invalidEvalsDir, localEdits, versionNotFound } from "../../errors";
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
  scanTasks,
  type TaskHashes,
  type TaskHashFile,
  taskFilter,
  taskHashFile,
} from "./dataset-state";
import {
  datasetApiError,
  forEachLimit,
  installTaskVersion,
  type PlacedVersion,
  type PullPlan,
  type PushPlan,
  planPull,
  planPush,
  removeTaskDir,
  type SkippedTask,
  shortHash,
  type TaskUpdate,
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
import { describeEvalPy } from "./describe";
import { hasEvalPy } from "./eval-py";
import { ensureTaskFiles } from "./task-files";
import { collectTaskFiles, envFiles } from "./task-hash";

const logger = initializeLogger();

export const DEFAULT_EVALS_DIR = "evals";

export interface DatasetSyncOpts extends GlobalOpts {
  dir?: string;
  task?: string[];
  force?: boolean;
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

/** The part of `local` Laminar doesn't have. */
const missingVersions = async (
  client: LaminarClient,
  dataset: string,
  local: TaskHashes,
): Promise<TaskHashes> => {
  const versions = Object.entries(local).map(([task, hash]) => ({
    task,
    hash,
  }));
  if (versions.length === 0) return {};
  try {
    const missing = await client.evalDatasets.missingVersions(
      dataset,
      versions,
    );
    return Object.fromEntries(missing.map(({ task, hash }) => [task, hash]));
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
  changed: TaskUpdate[];
  /** Push only: pinned versions uploaded because Laminar didn't have them. */
  stored?: TaskVersion[];
  /** Pull only. */
  removed?: TaskVersion[];
  /** Local tasks left alone, and why. */
  skipped: SkippedTask[];
}

const SKIPPED: Record<SkippedTask["reason"], string> = {
  unpushed: "not in dataset.toml, not in Laminar: push adds it",
  outdated:
    "Laminar has this version but dataset.toml pins another: pull to match it",
  unpinned:
    "not in dataset.toml, and Laminar has this version: pull removes it",
};

const printReport = (reports: DatasetReport[], verb: string) => {
  for (const r of reports) {
    const title = pc.bold(r.dataset) + pc.dim(` (${r.folder})`);
    const removed = r.removed ?? [];
    const stored = r.stored ?? [];
    const counts =
      `${r.added.length} added, ${r.changed.length} changed` +
      (r.removed ? `, ${removed.length} removed` : "") +
      (stored.length > 0 ? `, ${stored.length} pinned version(s) stored` : "");
    if (
      r.added.length + r.changed.length + removed.length + stored.length ===
      0
    ) {
      emitErr(`${title}: up to date\n`);
    } else {
      emitErr(`${title}: ${verb} ${counts}\n`);
    }
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
    for (const t of stored) {
      emitErr(`  ${pc.green("^")} ${t.task} ${pc.dim(shortHash(t.hash))}\n`);
    }
    for (const t of removed) {
      emitErr(`  ${pc.red("-")} ${t.task} ${pc.dim(shortHash(t.hash))}\n`);
    }
    for (const t of r.skipped) {
      emitErr(
        `  ${pc.dim("!")} ${t.task} ${pc.dim(shortHash(t.hash))} ` +
          pc.dim(`skipped: ${SKIPPED[t.reason]}`) +
          "\n",
      );
    }
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
  plan: PullPlan;
  downloads: PlacedVersion[];
  removals: PlacedVersion[];
}

/** Download, swap in and delete what `plan` says. */
const applyPull = async (
  client: LaminarClient,
  evalsDir: string,
  { dataset, downloads, removals }: PlannedPull,
) => {
  await ensureGitignore(evalsDir);
  await forEachLimit(downloads, TRANSFER_CONCURRENCY, (version) =>
    installTaskVersion(client, dataset.dir, dataset.manifest.name, version),
  );
  for (const { dir } of removals) await removeTaskDir(dataset.dir, dir);
};

/**
 * `lmnr-cli eval dataset pull [<dataset>...]`: bring `tasks/` to the versions
 * dataset.toml pins, and delete unpinned tasks Laminar has. Refuses (exit 22)
 * to overwrite versions Laminar doesn't have without `--force`, before
 * writing anything. Never writes dataset.toml.
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
  for (const dataset of datasets) {
    const { folder, dir: datasetDir, manifest } = dataset;
    const local = await scanTasks(datasetDir);
    assertNamedTasks(folder, local);
    const linked = linkedNames(folder, local, selected);
    const managed = (task: string) => selected(task) && !linked.has(task);
    const hashes = await hashLocalTasks(datasetDir, local, managed);
    const plan = planPull(
      {
        pins: manifest.pins,
        local: hashes,
        missing: await missingVersions(client, manifest.name, hashes),
      },
      { selected: managed, force: !!opts.force },
    );
    planned.push({
      dataset,
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
  }

  const conflicts = planned.flatMap(({ dataset, plan, downloads }) => {
    const dirs = new Map(downloads.map(({ task, dir }) => [task, dir]));
    return plan.conflicts.map(
      (task) =>
        `${task} (${taskPath(dataset.folder, dirs.get(task) ?? shortName(task))})`,
    );
  });
  if (conflicts.length > 0) {
    throw localEdits(
      `Pull would overwrite task versions Laminar doesn't have: ` +
        `${conflicts.join(", ")}. Push them first (then merge ` +
        `${DATASET_TOML} in git), or save your edits, pull with --force ` +
        "(which discards them) and re-apply them.",
    );
  }
  for (const { dataset, downloads } of planned) {
    const wanted = Object.fromEntries(
      downloads.map(({ task, hash }) => [task, hash]),
    );
    const missing = await missingVersions(
      client,
      dataset.manifest.name,
      wanted,
    );
    if (Object.keys(missing).length > 0) {
      throw versionNotFound(
        `Laminar doesn't have these task versions of ${dataset.manifest.name} ` +
          `that ${DATASET_TOML} pins: ` +
          Object.entries(missing)
            .map(([task, hash]) => `${task}@${shortHash(hash)}`)
            .join(", ") +
          ". Were they pushed?",
      );
    }
  }

  if (!opts.dryRun) {
    for (const p of planned) await applyPull(client, evalsDir, p);
  }
  report(
    planned.map(({ dataset, plan }) => ({
      dataset: dataset.manifest.name,
      folder: dataset.folder,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
      skipped: plan.skipped,
    })),
    opts,
    { done: "pulled", dryRun: "would pull" },
  );
};

interface PlannedPush {
  dataset: LocalDataset;
  /** Where its tasks were scanned: the dataset dir, or a copy on --dry-run. */
  dir: string;
  local: LocalTasks;
  plan: PushPlan;
}

/** The versions a push uploads: its new tasks, edits and unstored pins. */
const pushed = ({ plan }: PlannedPush): TaskVersion[] => [
  ...plan.added,
  ...plan.changed.map(({ task, to }) => ({ task, hash: to })),
  ...plan.stored,
];

/**
 * Upload the versions, then pin them in dataset.toml. If an upload fails, the
 * ones that finished are still pinned: unpinned, a retry would skip them as
 * dropped (Laminar has them) and a pull would delete them.
 */
const applyPush = async (
  client: LaminarClient,
  evalsDir: string,
  p: PlannedPush,
) => {
  const { dataset, local } = p;
  const upload = pushed(p);
  if (upload.length === 0) return;
  await ensureGitignore(evalsDir);
  const pins = { ...(dataset.manifest.pins ?? {}) };
  let pinned = 0;
  try {
    await forEachLimit(upload, TRANSFER_CONCURRENCY, async ({ task, hash }) => {
      await uploadTaskVersion(client, dataset.dir, dataset.manifest.name, {
        task,
        hash,
        dir: local.dirs[task],
      });
      if (pins[task] !== hash) {
        pins[task] = hash;
        pinned++;
      }
    });
  } finally {
    if (pinned > 0) await writeDatasetToml(dataset.dir, dataset.manifest, pins);
  }
};

/** Refuse to upload task files Laminar won't store (`.env*`). */
const assertNoEnvFiles = async (planned: PlannedPush[]) => {
  const found: string[] = [];
  for (const p of planned) {
    const { dataset, local } = p;
    for (const { task } of pushed(p)) {
      const dir = local.dirs[task];
      const { files } = await collectTaskFiles(
        path.join(p.dir, TASKS_DIR, dir),
      );
      found.push(
        ...envFiles(files).map((f) => `${taskPath(dataset.folder, dir)}/${f}`),
      );
    }
  }
  if (found.length > 0) {
    throw invalidEvalsDir(
      `Not pushing env files, which may hold secrets: ${found.join(", ")}. ` +
        "Delete them, or list them in the task's .gitignore; pass secrets " +
        "as ${VAR}s instead.",
    );
  }
};

/**
 * `lmnr-cli eval dataset push [<dataset>...]`: upload the versions of local
 * tasks Laminar doesn't have (new tasks and edits) and pin them in
 * dataset.toml. Tasks whose version Laminar has under another pin (or no pin)
 * are skipped with a warning.
 */
export const handleDatasetPush = async (
  named: string[],
  opts: DatasetSyncOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, named);
  const selected = selection(opts.task);
  const client = await buildEvalClient(opts);
  // Where each dataset's tasks are planned from: its own dir, except on
  // --dry-run for an eval.py dataset that lacks task files.
  const planDirs = new Map<string, string>();
  let scratch: string | undefined;
  const planned: PlannedPush[] = [];
  try {
    // eval.py datasets: no task is pushed without the files Harbor needs.
    for (const { folder, dir } of datasets) {
      if (!(await hasEvalPy(dir))) continue;
      const description = await describeEvalPy(dir);
      const changes = await ensureTaskFiles(dir, description, opts.dryRun);
      if (opts.dryRun && changes.length > 0) {
        // Plan from a copy with the files written, as a real push would:
        // new tasks and completed task.tomls change the plan.
        scratch ??= await mkdtemp(path.join(os.tmpdir(), "lmnr-push-dry-"));
        const copy = path.join(scratch, folder);
        await cp(path.join(dir, TASKS_DIR), path.join(copy, TASKS_DIR), {
          recursive: true,
          verbatimSymlinks: true,
        });
        await ensureTaskFiles(copy, description, false, false);
        planDirs.set(dir, copy);
      }
    }

    for (const dataset of datasets) {
      const { folder, manifest } = dataset;
      const dir = planDirs.get(dataset.dir) ?? dataset.dir;
      const local = await scanTasks(dir);
      assertNamedTasks(folder, local);
      const linked = linkedNames(folder, local, selected);
      const managed = (task: string) => selected(task) && !linked.has(task);
      const hashes = await hashLocalTasks(dir, local, managed);
      const plan = planPush({
        pins: manifest.pins,
        local: hashes,
        missing: await missingVersions(client, manifest.name, hashes),
      });
      planned.push({ dataset, dir, local, plan });
    }
    await assertNoEnvFiles(planned);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  if (!opts.dryRun) {
    for (const p of planned) await applyPush(client, evalsDir, p);
  }
  report(
    planned.map(({ dataset, plan }) => ({
      dataset: dataset.manifest.name,
      folder: dataset.folder,
      added: plan.added,
      changed: plan.changed,
      stored: plan.stored,
      skipped: plan.skipped,
    })),
    opts,
    { done: "pushed", dryRun: "would push" },
  );
};

/**
 * Before `eval run`, which runs the tasks on disk as they are and never pulls:
 * hash each eval dataset's task dirs `--task` selects (Harbor's matching, by
 * dir name), for the plugin and the remote upload. A dataset that pins tasks
 * but has none on disk (a fresh clone) is an error; pinned tasks that are
 * missing or differ from their pin (edited, or not pulled since a `git pull`)
 * only warn: run stays offline, so it can't tell those apart.
 */
export const checkRunTasks = async (
  evalsDir: string,
  folders: string[],
  taskGlobs: string[] | undefined,
  opts: { dir?: string } = {},
): Promise<Record<string, TaskHashFile>> => {
  const selectedDir = dirFilter((taskGlobs ?? []).map(globToRegExp));
  const result: Record<string, TaskHashFile> = {};
  for (const folder of folders) {
    const datasetDir = path.join(evalsDir, folder);
    const manifest = await readDatasetToml(datasetDir);
    if (!manifest) continue;
    const local = await scanTasks(datasetDir);
    const hashes = await taskHashFile(datasetDir, local, selectedDir);
    result[folder] = hashes;
    const pins = manifest.pins ?? {};
    const pull = `lmnr-cli eval dataset pull ${folder}${dirFlag(opts)}`;
    const onDisk = Object.keys(local.dirs).length + local.linked.length;
    if (onDisk === 0 && Object.keys(pins).length > 0) {
      throw invalidEvalsDir(
        `${taskPath(folder, "")} has no tasks, and ${DATASET_TOML} pins ` +
          `${Object.keys(pins).length} task(s). eval run runs the tasks on disk; ` +
          `pull them first: ${pull}`,
      );
    }
    const linked = linkedNames(folder, local, () => false);
    const localHash = Object.fromEntries(
      Object.values(hashes).map(({ name, hash }) => [name, hash]),
    );
    const missing: string[] = [];
    const differ: string[] = [];
    for (const [task, pin] of Object.entries(pins)) {
      if (linked.has(task)) continue;
      const dir = local.dirs[task];
      if (dir === undefined) {
        if (selectedDir(shortName(task))) missing.push(task);
      } else if (selectedDir(dir)) {
        if (localHash[task] !== pin) differ.push(task);
      }
    }
    if (missing.length + differ.length > 0) {
      const list = (tasks: string[]) =>
        tasks.slice(0, 5).join(", ") + (tasks.length > 5 ? ", ..." : "");
      logger.warn(
        `${manifest.name} runs the tasks on disk, which differ from ` +
          `${DATASET_TOML}:` +
          (missing.length > 0
            ? ` ${missing.length} pinned task(s) are not in tasks/ and won't ` +
              `run (${list(missing)});`
            : "") +
          (differ.length > 0
            ? ` ${differ.length} task(s) differ from their pin ` +
              `(${list(differ)});`
            : "") +
          (differ.length > 0
            ? ` push edits with \`${pull.replace(" pull ", " push ")}\`, or ` +
              `get the pinned versions with \`${pull}\``
            : ` get them with \`${pull}\``),
      );
    }
  }
  return result;
};
