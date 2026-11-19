import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { isValidHash, isValidTaskName, TASKS_DIR } from "./datasets";
import { hashTaskDir } from "./task-hash";
import { compareBytes } from "./tasks-toml";

/**
 * Local sync state, `<dataset>/tasks/.lmnr-state.json`: for each task, the
 * hash it had when it was last pulled or pushed on this disk (its "base").
 * A task dir whose hash differs from its base (or that has none) is edited.
 */
const logger = initializeLogger();

export const STATE_FILE = ".lmnr-state.json";

export type TaskHashes = Record<string, string>;

const stateFile = (datasetDir: string) =>
  path.join(datasetDir, TASKS_DIR, STATE_FILE);

export const readDatasetState = async (
  datasetDir: string,
): Promise<TaskHashes> => {
  const file = stateFile(datasetDir);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return {};
  let tasks: unknown;
  try {
    tasks = (JSON.parse(text) as { tasks?: unknown })?.tasks;
  } catch (error) {
    throw invalidEvalsDir(
      `Can't parse ${file}: ${errorMessage(error)}. Delete it; the next ` +
        "pull treats every task as edited (use --force).",
    );
  }
  const state: TaskHashes = {};
  if (typeof tasks !== "object" || tasks === null) return state;
  for (const [task, hash] of Object.entries(tasks)) {
    if (isValidTaskName(task) && isValidHash(hash)) state[task] = hash;
  }
  return state;
};

export const writeDatasetState = async (
  datasetDir: string,
  state: TaskHashes,
): Promise<void> => {
  await mkdir(path.join(datasetDir, TASKS_DIR), { recursive: true });
  const tasks = Object.fromEntries(
    Object.keys(state)
      .sort(compareBytes)
      .map((task) => [task, state[task]]),
  );
  await writeFile(
    stateFile(datasetDir),
    `${JSON.stringify({ tasks }, null, 2)}\n`,
  );
};

/**
 * Task dir names under `<dataset>/tasks/`: real directories only, sorted.
 * `invalid` lists dirs whose names Laminar wouldn't take; `linked` lists
 * symlinks, which Harbor follows but pull and push leave alone.
 */
export const listTaskDirs = async (
  datasetDir: string,
): Promise<{ tasks: string[]; invalid: string[]; linked: string[] }> => {
  const entries = await readdir(path.join(datasetDir, TASKS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  const tasks: string[] = [];
  const invalid: string[] = [];
  const linked: string[] = [];
  for (const entry of entries) {
    // Dot dirs are lmnr-cli's own temp dirs (or tool caches), never tasks.
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) linked.push(entry.name);
    if (!entry.isDirectory()) continue;
    (isValidTaskName(entry.name) ? tasks : invalid).push(entry.name);
  }
  return {
    tasks: tasks.sort(compareBytes),
    invalid: invalid.sort(),
    linked: linked.sort(compareBytes),
  };
};

/**
 * `selected` minus the dataset's symlinked task dirs, with a warning for each
 * selected one. Treating a link as missing would make pull replace it with a
 * downloaded copy and push drop its pin.
 */
export const unlinkedTasks = async (
  datasetDir: string,
  dataset: string,
  selected: (task: string) => boolean,
): Promise<(task: string) => boolean> => {
  const linked = new Set((await listTaskDirs(datasetDir)).linked);
  for (const task of linked) {
    if (selected(task)) {
      logger.warn(
        `Leaving ${dataset}/tasks/${task} alone: it is a symlink, which ` +
          "lmnr-cli doesn't pull, push or hash.",
      );
    }
  }
  return (task) => selected(task) && !linked.has(task);
};

/** The hash of each (valid) task dir of the dataset, optionally filtered. */
export const hashLocalTasks = async (
  datasetDir: string,
  include: (task: string) => boolean = () => true,
): Promise<TaskHashes> => {
  const { tasks } = await listTaskDirs(datasetDir);
  const hashes: TaskHashes = {};
  for (const task of tasks.filter(include)) {
    hashes[task] = await hashTaskDir(path.join(datasetDir, TASKS_DIR, task));
  }
  return hashes;
};

/** `--task` globs as a predicate (all tasks without any). */
export const taskFilter =
  (patterns: RegExp[]) =>
  (task: string): boolean =>
    patterns.length === 0 || patterns.some((p) => p.test(task));
