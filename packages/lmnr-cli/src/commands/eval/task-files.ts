import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { readDatasetToml } from "./dataset-toml";
import { NAME_RULE, SKIPPED_DIRS, TASKS_DIR } from "./datasets";
import { EVAL_PY, type EvalDescription, taskImageNames } from "./eval-py";

const logger = initializeLogger();

/**
 * Harbor only runs a task dir with `task.toml`, `instruction.md` and
 * `tests/test.sh`, and `task.toml` must name an image. For eval.py datasets
 * lmnr-cli writes whatever is missing into the task dir, so a new case is just
 * its data. After that `task.toml` is the task's source of truth: an existing
 * one is only completed (a missing key inserted as text, comments kept), never
 * rewritten.
 *
 * Tasks of an eval.py dataset never bring their own image: they start from one
 * the runner declares (`checkTaskImage`). Harbor would build or pull any other
 * image itself, without what the runner adds to its images (services, the
 * Laminar layer).
 */
export const INSTRUCTION_STUB = "Handle the case in this task.\n";
export const TEST_SH_STUB = `#!/bin/bash\necho "graded by ${EVAL_PY}"\n`;

/** One part of an `org/name` (`NAME_RULE`). */
const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isNamePart = (part: string) =>
  NAME_PART.test(part) && !part.includes("..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** What new tasks of a dataset get. */
interface TaskDefaults {
  /** The `[task] name` org: the `[dataset] name`'s, else the folder name. */
  org: string;
  /** `[environment] docker_image` of new tasks: the runner's default image. */
  image: string;
  /** Every `docker_image` a task may name: the runner's images. */
  images: string[];
  /** The runner's `new_task_toml`. */
  template: Record<string, unknown>;
  /**
   * Write a stub tests/test.sh. Not with `grade_with_test_sh`: there each task's
   * own test.sh grades, and a stub would hide a missing one.
   */
  testShStub: boolean;
}

const taskDefaults = async (
  datasetDir: string,
  description: EvalDescription,
): Promise<TaskDefaults> => {
  const manifest = await readDatasetToml(datasetDir);
  const org = manifest
    ? manifest.name.slice(0, manifest.name.indexOf("/"))
    : path.basename(datasetDir);
  if (!isNamePart(org)) {
    throw invalidEvalsDir(
      `New tasks of ${datasetDir} are named <org>/<dir>, and ${org} is no ` +
        `valid org: add tasks/dataset.toml with [dataset] name. ${NAME_RULE}`,
    );
  }
  return {
    org,
    image: description.default_image,
    images: taskImageNames(description),
    template: description.new_task_toml,
    testShStub: !description.grade_with_test_sh,
  };
};

/** A new task's `task.toml`: its name, the default image, then the template. */
const newTaskToml = (name: string, defaults: TaskDefaults): string => {
  const doc: Record<string, unknown> = {
    task: { name },
    environment: { docker_image: defaults.image },
  };
  for (const [key, value] of Object.entries(defaults.template)) {
    const current = doc[key];
    doc[key] =
      isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
  (doc.task as Record<string, unknown>).name = name;
  return stringifyToml(doc);
};

/**
 * `text` with `line` added to the `[table]` table: right after its header,
 * or as a new table before the first one (after the root keys, which would
 * otherwise move into it), else at the end.
 */
export const insertTomlKey = (
  text: string,
  table: string,
  line: string,
): string => {
  const header = new RegExp(
    `^[ \\t]*\\[[ \\t]*${table}[ \\t]*\\][ \\t]*(#.*)?(\\r?\\n|$)`,
    "m",
  );
  const found = header.exec(text);
  if (found) {
    const end = found.index + found[0].length;
    const newline = found[2] ? "" : "\n";
    return `${text.slice(0, end)}${newline}${line}\n${text.slice(end)}`;
  }
  const block = `[${table}]\n${line}\n`;
  const firstTable = /^[ \t]*\[/m.exec(text);
  if (firstTable) {
    // Above the comment lines right before that table: they describe it.
    let at = firstTable.index;
    for (;;) {
      const lineStart = text.lastIndexOf("\n", at - 2) + 1;
      if (at === 0 || !/^[ \t]*#/.test(text.slice(lineStart, at))) break;
      at = lineStart;
    }
    return `${text.slice(0, at)}${block}\n${text.slice(at)}`;
  }
  const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  return `${prefix}${prefix.trim() ? "\n" : ""}${block}`;
};

const tomlString = (value: string) => JSON.stringify(value);

/** A written (or, dry, would-be-written) file, relative to the dataset folder. */
interface TaskFileChange {
  file: string;
  change: "created" | "completed";
  /** For a completed task.toml: the keys added. */
  added?: string[];
}

const readTaskToml = async (
  tomlFile: string,
): Promise<{ text: string; doc: Record<string, unknown> } | null> => {
  const text = await readFile(tomlFile, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return { text, doc: parseToml(text) };
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${tomlFile}: ${errorMessage(error)}`);
  }
};

/**
 * Fail unless `taskDir` starts from one of the runner's images: no
 * `environment/Dockerfile`, and a `docker_image` (if set) the runner declares.
 */
const checkTaskImage = async (
  datasetDir: string,
  taskDir: string,
  defaults: TaskDefaults,
): Promise<void> => {
  const rel = path.relative(datasetDir, taskDir).split(path.sep).join("/");
  const hint =
    `Tasks of an ${EVAL_PY} dataset start from one of its runner's images ` +
    `(${defaults.images.join(", ")}). For a different system, declare a ` +
    `named image on the runner (image = {"default": ..., "<name>": ...}) ` +
    `and set docker_image = "<name>" in the task's task.toml.`;
  if (await exists(path.join(taskDir, "environment", "Dockerfile"))) {
    throw invalidEvalsDir(
      `${rel}/environment/Dockerfile: a task can't bring its own image. ${hint}`,
    );
  }
  const toml = await readTaskToml(path.join(taskDir, "task.toml"));
  const environment = isRecord(toml?.doc.environment)
    ? toml.doc.environment
    : {};
  const image = environment.docker_image;
  if (typeof image === "string" && !defaults.images.includes(image)) {
    throw invalidEvalsDir(
      `${rel}/task.toml: docker_image = ${tomlString(image)} isn't one of ` +
        `the runner's images. ${hint}`,
    );
  }
};

/**
 * Write the files Harbor needs that `taskDir` lacks. With `dryRun`, only
 * report them. Checks the task's image first (`checkTaskImage`).
 */
const ensureTaskDirFiles = async (
  datasetDir: string,
  taskDir: string,
  defaults: TaskDefaults,
  dryRun = false,
): Promise<TaskFileChange[]> => {
  const changes: TaskFileChange[] = [];
  const rel = (file: string) =>
    path.relative(datasetDir, file).split(path.sep).join("/");
  const dirName = path.basename(taskDir);
  const name = `${defaults.org}/${dirName}`;
  const assertNamePart = () => {
    if (!isNamePart(dirName)) {
      throw invalidEvalsDir(
        `Can't name task ${rel(taskDir)} after its dir: ${dirName} is no ` +
          `valid name part. Rename the dir, or write its task.toml with a ` +
          `[task] name. ${NAME_RULE}`,
      );
    }
  };
  await checkTaskImage(datasetDir, taskDir, defaults);

  const tomlFile = path.join(taskDir, "task.toml");
  const toml = await readTaskToml(tomlFile);
  if (toml === null) {
    assertNamePart();
    if (!dryRun) await writeFile(tomlFile, newTaskToml(name, defaults));
    changes.push({ file: rel(tomlFile), change: "created" });
  } else {
    const { text, doc } = toml;
    const needsName = !isRecord(doc.task) || typeof doc.task.name !== "string";
    const environment = isRecord(doc.environment) ? doc.environment : {};
    const needsImage = typeof environment.docker_image !== "string";
    // [environment] first, so a new [task] table lands above it.
    let updated = text;
    const added: string[] = [];
    if (needsName) assertNamePart();
    if (needsImage) {
      updated = insertTomlKey(
        updated,
        "environment",
        `docker_image = ${tomlString(defaults.image)}`,
      );
    }
    if (needsName) {
      updated = insertTomlKey(updated, "task", `name = ${tomlString(name)}`);
      added.push("[task] name");
    }
    if (needsImage) added.push("[environment] docker_image");
    if (added.length > 0) {
      if (!dryRun) await writeFile(tomlFile, updated);
      changes.push({ file: rel(tomlFile), change: "completed", added });
    }
  }

  const instruction = path.join(taskDir, "instruction.md");
  if (!(await exists(instruction))) {
    if (!dryRun) await writeFile(instruction, INSTRUCTION_STUB);
    changes.push({ file: rel(instruction), change: "created" });
  }
  const testSh = path.join(taskDir, "tests", "test.sh");
  if (defaults.testShStub && !(await exists(testSh))) {
    if (!dryRun) {
      await mkdir(path.dirname(testSh), { recursive: true });
      await writeFile(testSh, TEST_SH_STUB);
      await chmod(testSh, 0o755);
    }
    changes.push({ file: rel(testSh), change: "created" });
  }
  return changes;
};

/** Every task dir of a dataset: the non-dot dirs directly under `tasks/`. */
const taskDirs = async (datasetDir: string): Promise<string[]> => {
  const root = path.join(datasetDir, TASKS_DIR);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_DIRS.has(e.name),
    )
    .map((e) => path.join(root, e.name))
    .sort();
};

export const logTaskFileChanges = (
  folder: string,
  changes: TaskFileChange[],
  dryRun = false,
): void => {
  for (const { file, change, added } of changes) {
    const verb =
      change === "created"
        ? dryRun
          ? "would create"
          : "created"
        : dryRun
          ? "would add"
          : "added";
    logger.info(
      change === "created"
        ? `${verb} ${folder}/${file}`
        : `${verb} ${added?.join(", ")} to ${folder}/${file}`,
    );
  }
};

/**
 * Write the missing task files of every task of an eval.py dataset (before a
 * run hashes or packs them, and before a push hashes them). Logs each one.
 */
export const ensureTaskFiles = async (
  datasetDir: string,
  description: EvalDescription,
  dryRun = false,
  log = true,
): Promise<TaskFileChange[]> => {
  const defaults = await taskDefaults(datasetDir, description);
  const dirs = await taskDirs(datasetDir);
  // Every task's image first, so a bad one stops the run before any write.
  for (const taskDir of dirs) {
    await checkTaskImage(datasetDir, taskDir, defaults);
  }
  const changes: TaskFileChange[] = [];
  for (const taskDir of dirs) {
    changes.push(
      ...(await ensureTaskDirFiles(datasetDir, taskDir, defaults, dryRun)),
    );
  }
  if (log) logTaskFileChanges(path.basename(datasetDir), changes, dryRun);
  return changes;
};

/** Fail unless `name` can name a new task dir (a `NAME_RULE` part). */
export const assertTaskDirName = (name: string): void => {
  if (!isNamePart(name)) {
    throw invalidEvalsDir(`${name} is no valid task name part. ${NAME_RULE}`);
  }
};

/**
 * Create `<datasetDir>/tasks/<name>` (if needed) with the files Harbor needs
 * that it lacks, for `eval task new`. `missingTestSh`: it has no
 * tests/test.sh and gets no stub (`grade_with_test_sh`).
 */
export const writeNewTask = async (
  datasetDir: string,
  name: string,
  description: EvalDescription,
): Promise<{
  taskDir: string;
  changes: TaskFileChange[];
  missingTestSh: boolean;
}> => {
  assertTaskDirName(name);
  const defaults = await taskDefaults(datasetDir, description);
  const taskDir = path.join(datasetDir, TASKS_DIR, name);
  await mkdir(taskDir, { recursive: true });
  const changes = await ensureTaskDirFiles(datasetDir, taskDir, defaults);
  const missingTestSh =
    !defaults.testShStub &&
    !(await exists(path.join(taskDir, "tests", "test.sh")));
  return { taskDir, changes, missingTestSh };
};
