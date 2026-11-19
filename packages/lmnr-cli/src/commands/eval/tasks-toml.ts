import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import { TASKS_DIR } from "./datasets";
import { STATE_FILE } from "./pack";
import {
  byteOrder,
  HASH,
  isValidName,
  MAX_TASK_NAME,
  type TaskHashes,
} from "./tasks";

/** `<dataset>/tasks.toml`: the version (hash) of each task the repo pins. Committed. */
export const TASKS_TOML = "tasks.toml";
const TOML_HEADER =
  "# Task versions this eval dataset pins, written by `lmnr-cli eval dataset\n" +
  "# push` / `pull`. Commit it; `lmnr-cli eval dataset pull` gets the tasks.\n";
/** Keys TOML reads bare; any other (e.g. with a `.`, a dotted key) is quoted. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
/** What `<evals>/.gitignore` gets: every dataset's tasks live in Laminar. */
const GITIGNORE_ENTRY = `*/${TASKS_DIR}/`;

/** `tasks` sorted by name, in UTF-8 byte order. */
export const sortedTasks = (tasks: TaskHashes): [string, string][] =>
  Object.entries(tasks).sort(([a], [b]) => byteOrder(a, b));

export const sameTasks = (a: TaskHashes, b: TaskHashes): boolean => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
};

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/** Parsed `tasks.toml` content, or why it isn't valid. */
const parseTasks = (value: unknown): TaskHashes | string => {
  if (!isTable(value)) return "not a table";
  const extra = Object.keys(value).filter((k) => k !== "tasks");
  if (extra.length > 0) return `unknown key(s) ${extra.join(", ")}`;
  const tasks = value.tasks ?? {};
  if (!isTable(tasks)) return "`tasks` is not a table";
  for (const [name, hash] of Object.entries(tasks)) {
    if (!isValidName(name, MAX_TASK_NAME)) return `invalid task name ${name}`;
    if (typeof hash !== "string" || !HASH.test(hash)) {
      return `task ${name} has no valid hash (64 lowercase hex chars)`;
    }
  }
  return { ...(tasks as TaskHashes) };
};

/** The dataset's `tasks.toml`; null when it has none. Malformed → `invalid_evals_dir`. */
export const readTasksToml = async (
  datasetDir: string,
): Promise<TaskHashes | null> => {
  const file = path.join(datasetDir, TASKS_TOML);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  let parsed: TaskHashes | string;
  try {
    parsed = parseTasks(parseToml(text));
  } catch (error) {
    parsed = String(error);
  }
  if (typeof parsed === "string") {
    throw invalidEvalsDir(
      `${file} is not a valid ${TASKS_TOML} (${parsed}). Expected a [tasks] ` +
        'table of `<task> = "<64 hex hash>"`. Fix it, or restore it from git.',
    );
  }
  return parsed;
};

/** Write through a temp file, so an interrupted write never leaves half a file. */
const writeAtomic = async (file: string, content: string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
};

/** Task names never hold `"` or `\`, so quoting needs no escapes. */
const tomlKey = (name: string) => (BARE_KEY.test(name) ? name : `"${name}"`);

export const formatTasksToml = (tasks: TaskHashes): string =>
  TOML_HEADER +
  "[tasks]\n" +
  sortedTasks(tasks)
    .map(([name, hash]) => `${tomlKey(name)} = "${hash}"\n`)
    .join("");

export const writeTasksToml = (datasetDir: string, tasks: TaskHashes) =>
  writeAtomic(path.join(datasetDir, TASKS_TOML), formatTasksToml(tasks));

const statePath = (datasetDir: string) =>
  path.join(datasetDir, TASKS_DIR, STATE_FILE);

/**
 * The sync state, `tasks/.lmnr-state.json`: the hash of each task as it was
 * last pulled or pushed on this disk, plus `localHashes`, what such a task
 * hashes to on THIS disk where that differs (Windows has no exec bits, so it
 * hashes modes by extension). A task whose disk hash is its `localHashes`
 * entry is unchanged since the sync.
 */
export interface SyncState {
  tasks: TaskHashes;
  localHashes: TaskHashes;
}

const hashEntries = (value: unknown): TaskHashes =>
  Object.fromEntries(
    Object.entries(isTable(value) ? value : {}).filter(
      ([name, hash]) =>
        isValidName(name, MAX_TASK_NAME) &&
        typeof hash === "string" &&
        HASH.test(hash),
    ),
  ) as TaskHashes;

/**
 * What `tasks/` was last synced to. Empty when unknown: never synced, or the
 * file is unreadable (then every task in `tasks/` counts as locally edited).
 */
export const readState = async (datasetDir: string): Promise<SyncState> => {
  try {
    const value = JSON.parse(await readFile(statePath(datasetDir), "utf8"));
    const tasks = hashEntries(value?.tasks);
    const localHashes = Object.fromEntries(
      Object.entries(hashEntries(value?.localHashes)).filter(
        ([name]) => name in tasks,
      ),
    );
    return { tasks, localHashes };
  } catch {
    return { tasks: {}, localHashes: {} };
  }
};

export const sameState = (a: SyncState, b: SyncState) =>
  sameTasks(a.tasks, b.tasks) && sameTasks(a.localHashes, b.localHashes);

/** Record the sync state; `tasks/` must exist. */
export const writeState = (datasetDir: string, state: SyncState) =>
  writeAtomic(
    statePath(datasetDir),
    `${JSON.stringify(
      {
        tasks: Object.fromEntries(sortedTasks(state.tasks)),
        ...(Object.keys(state.localHashes).length > 0
          ? { localHashes: Object.fromEntries(sortedTasks(state.localHashes)) }
          : {}),
      },
      null,
      2,
    )}\n`,
  );

const IGNORES_TASKS = new Set([
  `*/${TASKS_DIR}`,
  `*/${TASKS_DIR}/`,
  `/*/${TASKS_DIR}`,
  `/*/${TASKS_DIR}/`,
]);

/**
 * Make `<evals>/.gitignore` ignore every dataset's `tasks/`: tasks live in
 * Laminar, and each `tasks.toml` pins them. Returns whether it changed.
 */
export const ensureGitignore = async (evalsDir: string): Promise<boolean> => {
  const file = path.join(evalsDir, ".gitignore");
  const text = (await readFile(file, "utf8").catch(() => null)) ?? "";
  if (text.split(/\r?\n/).some((line) => IGNORES_TASKS.has(line.trim()))) {
    return false;
  }
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${text}${sep}${GITIGNORE_ENTRY}\n`);
  return true;
};
