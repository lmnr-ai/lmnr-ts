import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient, TaskSetVersion } from "@lmnr-ai/client";

import { errorMessage } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { evalNotFound, invalidEvalsDir, mergeConflict } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { emitData, outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { buildEvalClient } from "./client";
import { fileSha256 } from "./digest";
import {
  assertName,
  assertTaskImages,
  dirExists,
  discoverTaskSets,
  EVAL_CONFIG,
  hasEvalConfig,
  ignoreTasks,
  loadEvalConfig,
  readState,
  tasksDir,
  writeState,
} from "./layout";
import { applyMerge, planMerge } from "./merge";
import { walkFiles } from "./pack";
import {
  downloadBlob,
  otherEntryDigests,
  pushTaskSetVersion,
  setDigests,
  taskDigests,
} from "./store";

const logger = initializeLogger();

export interface SyncOpts extends GlobalOpts {
  dir: string;
}

export interface PullOpts extends SyncOpts {
  force?: boolean;
}

/** `<set>[@<number>]`. */
export interface Target {
  taskSet: string;
  number?: number;
}

export const parseTarget = (raw: string): Target => {
  const match = /^([^@]+)(?:@(\d+))?$/.exec(raw);
  if (!match) {
    throw invalidEvalsDir(
      `Invalid task set "${raw}": expected <set> or <set>@<version>.`,
    );
  }
  const [, taskSet, number] = match;
  assertName("task set", taskSet);
  return {
    taskSet,
    ...(number === undefined ? {} : { number: Number(number) }),
  };
};

/** The task set version numbered `number`. */
export const findTaskSetVersion = async (
  client: LaminarClient,
  taskSet: string,
  number: number,
): Promise<TaskSetVersion> => {
  const versions = await client.hostedEvals.listTaskSetVersions(taskSet);
  const version = versions?.find((v) => v.number === number);
  if (!version) {
    throw evalNotFound(`Task set ${taskSet} has no version ${number}.`);
  }
  return version;
};

export const withTempDir = async <T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface PullResult {
  taskSet: string;
  version: number;
  updated: string[];
  removed: string[];
}

/**
 * Merge `version` into the local tasks copy at `dir` task by task (see
 * `planMerge`), then record it as the copy's base. Fails, changing nothing, on
 * a task both sides changed.
 */
export const pullTaskSet = async (
  client: LaminarClient,
  taskSet: string,
  dir: string,
  version: TaskSetVersion,
): Promise<PullResult> =>
  withTempDir("lmnr-pull-", async (remoteDir) => {
    await downloadBlob(client, version.hash, remoteDir);
    const remote = await setDigests(remoteDir);
    const local = (await dirExists(dir))
      ? await setDigests(dir)
      : { tasks: {}, files: {} };
    const state = await readState(dir);
    const plan = planMerge(
      { ...state?.tasks, ...state?.files },
      { ...local.tasks, ...local.files },
      { ...remote.tasks, ...remote.files },
    );
    if (plan.conflicts.length > 0) {
      throw mergeConflict(
        `Tasks or files changed both locally and in Laminar (${taskSet} ` +
          `v${version.number}): ${plan.conflicts.join(", ")}. Move ` +
          "your local copy of each aside, pull, and re-apply your changes.",
      );
    }
    await applyMerge(dir, remoteDir, plan);
    await writeState(dir, {
      versionId: version.id,
      number: version.number,
      hash: version.hash,
      tasks: remote.tasks,
      files: remote.files,
    });
    return {
      taskSet,
      version: version.number,
      updated: plan.take,
      removed: plan.remove,
    };
  });

/**
 * Publish the local tasks copy at `dir` as the set's new head. When the head
 * moved since the copy's base, Laminar's head is merged in first (a conflict
 * fails) and the push is retried once.
 */
export const pushTaskSet = async (
  client: LaminarClient,
  taskSet: string,
  dir: string,
): Promise<TaskSetVersion> => {
  await assertTaskImages(dir);
  let base = (await readState(dir))?.versionId ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result, tasks } = await pushTaskSetVersion(
      client,
      taskSet,
      dir,
      base,
    );
    if ("version" in result) {
      const digests = taskDigests(tasks);
      await writeState(dir, {
        versionId: result.version.id,
        number: result.version.number,
        hash: result.version.hash,
        tasks: digests,
        files: await otherEntryDigests(dir, digests),
      });
      return result.version;
    }
    const head = result.headMoved;
    if (head) {
      logger.info(
        `${taskSet} changed in Laminar (now v${head.number}); merging it in`,
      );
      await pullTaskSet(client, taskSet, dir, head);
    }
    base = head?.id ?? null;
  }
  throw mergeConflict(
    `${taskSet} keeps changing in Laminar; pull and push again.`,
  );
};

const versionLabel = (v: { number: number } | null) =>
  v ? `v${v.number}` : "-";

/**
 * What on `target`'s path under `root` stops a copy into it: a symlink (the
 * copy would write through it), or an entry of the wrong kind (a file where a
 * folder is needed, or a folder where the file goes). Paths relative to `root`.
 */
const blockerOnPath = async (
  root: string,
  target: string,
): Promise<{ rel: string; kind: "link" | "type" } | null> => {
  const parts = target.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    const stats = await lstat(path.join(root, rel)).catch(() => null);
    if (!stats) return null;
    if (stats.isSymbolicLink()) return { rel, kind: "link" };
    const last = i === parts.length;
    if (last ? !stats.isFile() : !stats.isDirectory()) {
      return { rel, kind: "type" };
    }
  }
  return null;
};

/**
 * Extract the scripts blob `hash` over `evalsDir`, keeping only `taskSet`'s
 * folder and the shared entries (top-level entries that aren't other task
 * sets). Without `force`, fails (writing nothing) when it would overwrite a
 * local file with different content or a symlink; `force` replaces the link,
 * never what it points to. Local files the blob doesn't have stay.
 */
export const pullScripts = async (
  client: LaminarClient,
  evalsDir: string,
  taskSet: string,
  hash: string,
  force: boolean,
): Promise<string[]> =>
  withTempDir("lmnr-pull-", async (remoteDir) => {
    await downloadBlob(client, hash, remoteDir);
    const otherSets = new Set(
      (await discoverTaskSets(remoteDir)).filter((s) => s !== taskSet),
    );
    const files = (await walkFiles(remoteDir)).files.filter(
      (f) => !otherSets.has(f.target.split("/")[0]),
    );
    const changed = new Set<string>();
    // A symlink on the way would make the copy write through it.
    const links = new Set<string>();
    const blocked = new Set<string>();
    for (const file of files) {
      const blocker = await blockerOnPath(evalsDir, file.target);
      if (blocker?.kind === "link") {
        links.add(blocker.rel);
        changed.add(blocker.rel);
        continue;
      }
      if (blocker) {
        blocked.add(blocker.rel);
        continue;
      }
      const local = path.join(evalsDir, file.target);
      const stats = await lstat(local).catch(() => null);
      if (
        stats?.isFile() &&
        (await fileSha256(local)) !== (await fileSha256(file.source))
      ) {
        changed.add(file.target);
      }
    }
    // --force replaces files and links, never a local folder or what's in it.
    if (blocked.size > 0) {
      throw mergeConflict(
        `Laminar's scripts need a file where you have a folder, or a folder ` +
          `where you have a file: ${[...blocked].join(", ")}. Move them aside ` +
          "and pull again.",
      );
    }
    if (changed.size > 0 && !force) {
      throw mergeConflict(
        `Laminar's scripts would overwrite local changes: ${[...changed].join(", ")}. ` +
          "Commit or move them aside, or pass --force.",
      );
    }
    for (const link of links) await rm(path.join(evalsDir, link));
    for (const file of files) {
      const dest = path.join(evalsDir, file.target);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file.source, dest);
    }
    return files.map((f) => f.target);
  });

/**
 * One set of `eval pull`: its scripts first when the repo has no eval.yaml for
 * it (the copy its last run used), then its tasks into `<set>/tasks/`.
 */
const pullOne = async (
  client: LaminarClient,
  evalsDir: string,
  target: Target,
  heads: Map<string, TaskSetVersion | null>,
  force: boolean,
): Promise<PullResult & { scripts: boolean }> => {
  const { taskSet } = target;
  if (!heads.has(taskSet)) {
    throw evalNotFound(`No task set ${taskSet} in Laminar.`);
  }
  const setDir = path.join(evalsDir, taskSet);
  let scripts = false;
  let noScripts = false;
  if (!(await hasEvalConfig(setDir))) {
    const latest = await client.hostedEvals.getLatestScripts(taskSet);
    if (latest) {
      await pullScripts(client, evalsDir, taskSet, latest.hash, force);
      scripts = true;
      logger.info(
        `Pulled the scripts ${taskSet}'s last run used (${latest.usedAt}). ` +
          "Commit them to your repo: eval run uses the repo's scripts.",
      );
    } else {
      noScripts = true;
    }
  }
  const version =
    target.number !== undefined
      ? await findTaskSetVersion(client, taskSet, target.number)
      : heads.get(taskSet);
  if (!version) {
    throw evalNotFound(`Task set ${taskSet} has no pushed version.`);
  }
  const result = await pullTaskSet(client, taskSet, tasksDir(setDir), version);
  await ignoreTasks(setDir);
  logger.info(
    `Pulled ${taskSet} ${versionLabel(version)}: ` +
      `${result.updated.length} updated, ${result.removed.length} removed`,
  );
  if (noScripts) {
    logger.warn(
      `${taskSet} has no scripts: no ${path.join(setDir, EVAL_CONFIG)}, and no ` +
        "run of it recorded any. Write its eval.yaml (images, Harbor job) to run it.",
    );
  }
  return { ...result, scripts };
};

/** `lmnr-cli eval pull <set>[@<version>]...`. */
export const handleEvalPull = async (
  rawTargets: string[],
  opts: PullOpts,
): Promise<void> => {
  const targets = rawTargets.map(parseTarget);
  if (targets.length === 0) {
    throw invalidEvalsDir("Name the task sets to pull: eval pull <set>...");
  }
  const evalsDir = path.resolve(opts.dir);
  const client = await buildEvalClient(opts);
  const heads = new Map(
    (await client.hostedEvals.listTaskSets()).map((s) => [s.name, s.head]),
  );
  const results = [];
  for (const target of targets) {
    results.push(await pullOne(client, evalsDir, target, heads, !!opts.force));
  }
  if (opts.json) outputJson({ taskSets: results });
};

/**
 * The eval.yaml pin, for push's hints only: push doesn't use the scripts, so a
 * broken eval.yaml must not block publishing tasks. `undefined` = no pin,
 * `null` = unreadable.
 */
const pinForHints = async (
  setDir: string,
): Promise<number | undefined | null> => {
  if (!(await hasEvalConfig(setDir))) return undefined;
  try {
    return (await loadEvalConfig(setDir)).version;
  } catch (error) {
    logger.warn(`Skipping pin hints: ${errorMessage(error)}`);
    return null;
  }
};

/** Local sets with a tasks copy: what a bare `eval push` publishes. */
const setsWithTasks = async (evalsDir: string): Promise<string[]> => {
  const sets: string[] = [];
  for (const name of await discoverTaskSets(evalsDir)) {
    if (await dirExists(tasksDir(path.join(evalsDir, name)))) sets.push(name);
  }
  return sets;
};

/** `lmnr-cli eval push [sets...]`. */
export const handleEvalPush = async (
  rawTargets: string[],
  opts: SyncOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir);
  const targets = rawTargets.map(parseTarget);
  if (targets.some((t) => t.number !== undefined)) {
    throw invalidEvalsDir("Push publishes a new version; drop the @<version>.");
  }
  const sets =
    targets.length > 0
      ? targets.map((t) => t.taskSet)
      : await setsWithTasks(evalsDir);
  if (sets.length === 0) {
    throw invalidEvalsDir(
      `Nothing to push: no task set in ${evalsDir} has a tasks/ folder.`,
    );
  }
  for (const set of sets) {
    if (!(await dirExists(tasksDir(path.join(evalsDir, set))))) {
      throw invalidEvalsDir(
        `No ${tasksDir(path.join(evalsDir, set))}: nothing to push for ${set}.`,
      );
    }
  }

  const client = await buildEvalClient(opts);
  const taskSets: { taskSet: string; version: TaskSetVersion }[] = [];
  for (const set of sets) {
    const setDir = path.join(evalsDir, set);
    const pin = await pinForHints(setDir);
    const version = await pushTaskSet(client, set, tasksDir(setDir));
    taskSets.push({ taskSet: set, version });
    await ignoreTasks(setDir);
    logger.info(`Pushed ${set} as ${versionLabel(version)}`);
    if (pin === undefined) {
      logger.info(
        `Pin it: set \`version: ${version.number}\` in ` +
          `${path.join(opts.dir, set, EVAL_CONFIG)} so runs and CI use this version.`,
      );
    } else if (pin !== null && pin !== version.number) {
      logger.info(
        `${set}'s ${EVAL_CONFIG} pins v${pin}; set \`version: ${version.number}\` ` +
          "to run this version in CI.",
      );
    }
  }
  if (opts.json) outputJson({ taskSets });
};

/** `lmnr-cli eval list`. */
export const handleEvalList = async (opts: GlobalOpts): Promise<void> => {
  const client = await buildEvalClient(opts);
  const taskSets = await client.hostedEvals.listTaskSets();
  if (opts.json) {
    outputJson({ taskSets });
    return;
  }
  emitData(
    renderTable(
      ["Task set", "Head"],
      taskSets.map((set) => [set.name, versionLabel(set.head)]),
    ),
  );
};
