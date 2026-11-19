import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import { isValidHash, isValidTaskName, TASKS_TOML } from "./datasets";

/** A dataset's pins: task name → the version hash it runs. */
export type TaskPins = Record<string, string>;

const HEADER =
  "# Managed by lmnr-cli (eval dataset pull / push). " +
  "Task versions are content hashes.\n";

/** Bytewise (UTF-8) order, the way Laminar sorts task ids. */
export const compareBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Parse a `tasks.toml`: only a `[tasks]` table of `name = "<hash>"`. */
export const parseTasksToml = (text: string, file: string): TaskPins => {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${errorMessage(error)}`);
  }
  const extra = Object.keys(parsed).filter((key) => key !== "tasks");
  if (extra.length > 0) {
    throw invalidEvalsDir(
      `${file}: only a [tasks] table is allowed, found ${extra.join(", ")}.`,
    );
  }
  const tasks = parsed.tasks ?? {};
  if (typeof tasks !== "object" || Array.isArray(tasks) || tasks === null) {
    throw invalidEvalsDir(`${file}: tasks must be a table.`);
  }
  const pins: TaskPins = {};
  for (const [task, hash] of Object.entries(tasks)) {
    if (!isValidTaskName(task)) {
      throw invalidEvalsDir(`${file}: invalid task name "${task}".`);
    }
    if (!isValidHash(hash)) {
      throw invalidEvalsDir(
        `${file}: tasks.${task} must be a version hash (64 lowercase hex ` +
          "characters).",
      );
    }
    pins[task] = hash;
  }
  return pins;
};

/** Bare keys can't hold `.` (a dotted key); task names hold nothing to escape. */
const tomlKey = (task: string) =>
  /^[A-Za-z0-9_-]+$/.test(task) ? task : `"${task}"`;

/** The `tasks.toml` text for `pins`: a header comment, keys sorted. */
export const formatTasksToml = (pins: TaskPins): string =>
  `${HEADER}[tasks]\n` +
  Object.keys(pins)
    .sort(compareBytes)
    .map((task) => `${tomlKey(task)} = "${pins[task]}"\n`)
    .join("");

/** The dataset's pins, or null when it has no `tasks.toml`. */
export const readTasksToml = async (
  datasetDir: string,
): Promise<TaskPins | null> => {
  const file = path.join(datasetDir, TASKS_TOML);
  const text = await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : parseTasksToml(text, file);
};

export const writeTasksToml = async (
  datasetDir: string,
  pins: TaskPins,
): Promise<void> => {
  await writeFile(path.join(datasetDir, TASKS_TOML), formatTasksToml(pins));
};
