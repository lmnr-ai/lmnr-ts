import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { compareBytes } from "./dataset-toml";
import { isValidHash, isValidName, NAME_RULE, TASKS_DIR } from "./datasets";
import { hashTaskDir } from "./task-hash";

/**
 * Local sync state, `<dataset>/tasks/.lmnr-state.json`: for each task (by
 * name), the hash it had when it was last pulled or pushed on this disk (its
 * "base"). A task whose hash differs from its base (or that has none) is
 * edited.
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
    if (isValidName(task) && isValidHash(hash)) state[task] = hash;
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

/** What `<dataset>/tasks/` holds, by `[task] name` from each `task.toml`. */
export interface LocalTasks {
  /** Task name → its dir name, for dirs with a valid `[task] name`. */
  dirs: Record<string, string>;
  /** Dirs with a `task.toml` but no valid `[task] name`, and why. */
  unnamed: { dir: string; problem: string }[];
  /** Names more than one dir claims, with those dirs. */
  duplicates: Record<string, string[]>;
  /**
   * Symlinked dirs (with the task name, if they hold one): Harbor follows
   * them, pull and push leave them alone.
   */
  linked: { dir: string; name?: string }[];
  /**
   * Every entry, task or not (dirs, links, files such as `dataset.toml`):
   * where a pull can't put another task.
   */
  taken: Set<string>;
}

const taskNameOf = async (
  taskToml: string,
): Promise<{ name: string } | { problem: string } | null> => {
  const text = await readFile(taskToml, "utf8").catch(() => null);
  if (text === null) return null;
  let name: unknown;
  try {
    name = (parseToml(text).task as { name?: unknown } | undefined)?.name;
  } catch (error) {
    return { problem: `can't parse task.toml: ${errorMessage(error)}` };
  }
  if (name === undefined) return { problem: "task.toml has no [task] name" };
  if (!isValidName(name)) {
    return { problem: `invalid [task] name ${JSON.stringify(name)}` };
  }
  return { name };
};

/** Scan `<datasetDir>/tasks/`: task dirs are those with a `task.toml`. */
export const scanTasks = async (datasetDir: string): Promise<LocalTasks> => {
  const tasksDir = path.join(datasetDir, TASKS_DIR);
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(
    () => [],
  );
  const found: LocalTasks = {
    dirs: {},
    unnamed: [],
    duplicates: {},
    linked: [],
    taken: new Set(),
  };
  entries.sort((a, b) => compareBytes(a.name, b.name));
  for (const entry of entries) {
    // Dot dirs are lmnr-cli's own temp dirs (or tool caches), never tasks.
    if (entry.name.startsWith(".")) continue;
    // A task named `<org>/dataset.toml` must not land on the manifest.
    found.taken.add(entry.name);
    const linked = entry.isSymbolicLink();
    if (!linked && !entry.isDirectory()) continue;
    const task = await taskNameOf(path.join(tasksDir, entry.name, "task.toml"));
    if (linked) {
      found.linked.push({
        dir: entry.name,
        ...(task && "name" in task ? { name: task.name } : {}),
      });
      continue;
    }
    if (task === null) continue;
    if ("problem" in task) {
      found.unnamed.push({ dir: entry.name, problem: task.problem });
      continue;
    }
    const other = found.dirs[task.name];
    if (other !== undefined) {
      found.duplicates[task.name] = [
        ...(found.duplicates[task.name] ?? [other]),
        entry.name,
      ];
    } else {
      found.dirs[task.name] = entry.name;
    }
  }
  for (const name of Object.keys(found.duplicates)) delete found.dirs[name];
  return found;
};

/**
 * Fail on tasks pull and push can't tell apart: `task.toml`s without a valid
 * `[task] name`, and names claimed by more than one dir (a copied task whose
 * name wasn't changed).
 */
export const assertNamedTasks = (dataset: string, local: LocalTasks): void => {
  const problems = [
    ...local.unnamed.map(
      ({ dir, problem }) => `${dataset}/tasks/${dir}: ${problem}`,
    ),
    ...Object.entries(local.duplicates).map(
      ([name, dirs]) =>
        `${dirs.map((d) => `${dataset}/tasks/${d}`).join(", ")} all have ` +
        `[task] name = "${name}"`,
    ),
  ];
  if (problems.length === 0) return;
  throw invalidEvalsDir(
    "Every task needs its own [task] name in task.toml (Laminar and Harbor " +
      `know tasks by it):\n  ${problems.join("\n  ")}\n` +
      `${NAME_RULE} After copying a task, give the copy a new name.`,
  );
};

/**
 * The names of the symlinked tasks, which pull and push leave alone (treating
 * one as missing would replace the link with a download, or drop its pin),
 * with a warning for each one `selected` takes.
 */
export const linkedNames = (
  dataset: string,
  local: LocalTasks,
  selected: (name: string) => boolean,
): Set<string> => {
  const names = new Set<string>();
  for (const { dir, name } of local.linked) {
    if (name === undefined) continue;
    names.add(name);
    if (!selected(name)) continue;
    logger.warn(
      `Leaving ${dataset}/tasks/${dir} alone: it is a symlink, which ` +
        "lmnr-cli doesn't pull, push or hash.",
    );
  }
  return names;
};

/** The hash of each named task, by name, for those `include` takes. */
export const hashLocalTasks = async (
  datasetDir: string,
  local: LocalTasks,
  include: (name: string, dir: string) => boolean = () => true,
): Promise<TaskHashes> => {
  const hashes: TaskHashes = {};
  for (const [name, dir] of Object.entries(local.dirs)) {
    if (!include(name, dir)) continue;
    hashes[name] = await hashTaskDir(path.join(datasetDir, TASKS_DIR, dir));
  }
  return hashes;
};

/**
 * `eval dataset --task` globs as a predicate on task names (all tasks
 * without any): a glob matches the full `org/name` or the name after the org.
 */
export const taskFilter =
  (patterns: RegExp[]) =>
  (task: string): boolean =>
    patterns.length === 0 ||
    patterns.some(
      (p) => p.test(task) || p.test(task.slice(task.indexOf("/") + 1)),
    );

/** `eval run --task` globs (Harbor's: task dir names) as a predicate. */
export const dirFilter =
  (patterns: RegExp[]) =>
  (dir: string): boolean =>
    patterns.length === 0 || patterns.some((p) => p.test(dir));

/**
 * The Harbor plugin's `task_hashes_file`: each named task's dir (Harbor's
 * task id) → its name and version hash. Duplicate names are left out.
 */
export type TaskHashFile = Record<string, { name: string; hash: string }>;

export const taskHashFile = async (
  datasetDir: string,
  local: LocalTasks,
  include: (dir: string) => boolean = () => true,
): Promise<TaskHashFile> => {
  const file: TaskHashFile = {};
  for (const [name, dir] of Object.entries(local.dirs)) {
    if (!include(dir)) continue;
    file[dir] = {
      name,
      hash: await hashTaskDir(path.join(datasetDir, TASKS_DIR, dir)),
    };
  }
  return file;
};
