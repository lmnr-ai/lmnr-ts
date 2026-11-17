import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";
import type { ImageDef } from "./images";

/**
 * The evals folder: one dir per task set, holding its scripts (in git) and a
 * working copy of its tasks (from Laminar). Other dirs hold shared files.
 *
 *   evals/<set>/eval.yaml                 images, Harbor JobConfig, `version` pin
 *   evals/<set>/...                       scripts (adapter, Dockerfiles, seed loaders)
 *   evals/<set>/tasks/.lmnr.json          the version this copy is based on
 *   evals/<set>/tasks/<task>/task.toml    one dir per task
 *   evals/<shared>/...                    no eval.yaml: files sets share
 */
export const EVAL_CONFIG = "eval.yaml";
export const TASKS_DIR = "tasks";
export const STATE_FILE = ".lmnr.json";

/**
 * Never walked into: VCS data, dependency/build caches and Harbor job output.
 * Not packed for upload (`pack.ts`) and not hashed.
 */
export const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "jobs",
]);

/** `module:Class` Harbor loads for remote trials; the module is written by `harbor.ts`. */
export const LAMINAR_ENVIRONMENT_IMPORT_PATH =
  "lmnr_hosted_env:LaminarEnvironment";

/** Harbor's `${VAR}` / `${VAR:-default}` placeholders (`harbor.utils.env`). */
const TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

/** Task set names: they go into API paths and directory names. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const isValidName = (name: string): boolean => NAME.test(name);

export const assertName = (kind: string, name: string): void => {
  if (!isValidName(name)) {
    throw invalidEvalsDir(
      `Invalid ${kind} name "${name}": use letters, digits, ".", "_" and "-" ` +
        "(at most 100 characters, starting with a letter or digit).",
    );
  }
};

export interface RunOverrides {
  tasks?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  /** `--env` names: referenced as `${KEY}` from every Harbor agent's env. */
  extraAgentEnv?: string[];
}

export type JobConfig = Record<string, unknown>;

export interface EvalConfig {
  /** Images tasks can name in `docker_image`, built from the set's Dockerfiles. */
  images: ImageDef[];
  /** Harbor JobConfig without datasets/tasks: the set's tasks are the dataset. */
  job: JobConfig;
  /** `version:` pin: the version number runs use when there's no local copy. */
  version?: number;
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

const isFile = (p: string) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

const childDirs = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
};

export const hasEvalConfig = (setDir: string) =>
  isFile(path.join(setDir, EVAL_CONFIG));

/** Task set dirs (holding eval.yaml) directly inside the evals folder, sorted. */
export const discoverTaskSets = async (evalsDir: string): Promise<string[]> => {
  const sets: string[] = [];
  for (const name of await childDirs(evalsDir)) {
    if (await hasEvalConfig(path.join(evalsDir, name))) sets.push(name);
  }
  return sets;
};

/** A task set's working copy of its tasks. */
export const tasksDir = (setDir: string) => path.join(setDir, TASKS_DIR);

export const loadEvalConfig = async (setDir: string): Promise<EvalConfig> => {
  const file = path.join(setDir, EVAL_CONFIG);
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw invalidEvalsDir(`Can't read ${file}: ${String(error)}`);
  }
  if (parsed == null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidEvalsDir(`${file} must be a mapping.`);
  }
  const raw = parsed as { images?: unknown; job?: unknown; version?: unknown };
  const images: ImageDef[] = [];
  for (const [name, def] of Object.entries(
    (raw.images ?? {}) as Record<
      string,
      { dockerfile?: unknown; context?: unknown }
    >,
  )) {
    if (typeof def?.dockerfile !== "string") {
      throw invalidEvalsDir(`${file}: images.${name}.dockerfile is required.`);
    }
    const dockerfile = path.resolve(setDir, def.dockerfile);
    const context =
      typeof def.context === "string"
        ? path.resolve(setDir, def.context)
        : path.dirname(dockerfile);
    images.push({ name, dockerfile, context });
  }
  const job = raw.job ?? {};
  if (typeof job !== "object" || Array.isArray(job)) {
    throw invalidEvalsDir(
      `${file}: job must be a mapping (a Harbor JobConfig).`,
    );
  }
  const { version } = raw;
  if (
    version !== undefined &&
    version !== null &&
    (!Number.isInteger(version) || (version as number) < 1)
  ) {
    throw invalidEvalsDir(
      `${file}: version must be a version number (1, 2, ...).`,
    );
  }
  return {
    images,
    job: job as JobConfig,
    ...(typeof version === "number" ? { version } : {}),
  };
};

/** fnmatch-style glob (`*`, `?`, `[...]`), the way Harbor filters task names. */
export const globToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
      } else {
        let set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

/**
 * The task dirs of a task set (direct children holding a task.toml), by name,
 * narrowed by `--task` globs the way Harbor matches local task names.
 */
export const findTaskDirs = async (
  setDir: string,
  taskGlobs?: string[],
): Promise<string[]> => {
  const patterns = (taskGlobs ?? []).map(globToRegExp);
  const dirs: string[] = [];
  for (const name of await childDirs(setDir)) {
    if (patterns.length > 0 && !patterns.some((p) => p.test(name))) continue;
    if (await isFile(path.join(setDir, name, "task.toml"))) {
      dirs.push(path.join(setDir, name));
    }
  }
  return dirs;
};

/**
 * Every task names its image (`docker_image`, normally one from eval.yaml):
 * remote trials only start from pushed images, and a task that builds its own
 * environment would carry code that belongs to the set's scripts.
 */
export const assertTaskImages = async (setDir: string): Promise<void> => {
  const ownBuilds: string[] = [];
  const noImage: string[] = [];
  for (const dir of await findTaskDirs(setDir)) {
    for (const file of ["Dockerfile", "docker-compose.yaml"]) {
      if (await isFile(path.join(dir, "environment", file))) {
        ownBuilds.push(`${path.basename(dir)}/environment/${file}`);
      }
    }
    if (!(await readTaskToml(dir)).dockerImage) {
      noImage.push(path.basename(dir));
    }
  }
  if (ownBuilds.length > 0) {
    throw invalidEvalsDir(
      `Tasks in ${setDir} build their own environment: ` +
        `${ownBuilds.join(", ")}. Name an image from eval.yaml with ` +
        "docker_image in task.toml instead, and keep per-task data in environment/.",
    );
  }
  if (noImage.length > 0) {
    throw invalidEvalsDir(
      `Tasks in ${setDir} name no image: ${noImage.join(", ")}. Set ` +
        "[environment] docker_image in their task.toml to an image from eval.yaml.",
    );
  }
};

/** A task's `docker_image` and `[metadata]`, from its task.toml. */
export const readTaskToml = async (
  taskDir: string,
): Promise<{ dockerImage?: string; metadata?: Record<string, unknown> }> => {
  const file = path.join(taskDir, "task.toml");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${String(error)}`);
  }
  const environment = parsed.environment as Record<string, unknown> | undefined;
  const metadata = parsed.metadata;
  return {
    dockerImage:
      typeof environment?.docker_image === "string"
        ? environment.docker_image
        : undefined,
    metadata:
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined,
  };
};

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> => typeof v === "object" && !!v,
      )
    : [];

/**
 * One task set's Harbor JobConfig: eval.yaml's `job` with the set's tasks as
 * its only dataset, CLI overrides applied, and with `remote` trials routed to
 * Laminar sandboxes. `harbor run` flags can't override a `-c` config's
 * datasets and `-m` only applies with `-a`, so overrides go into the config.
 */
export const buildJobConfig = (
  job: JobConfig,
  tasks: string,
  overrides: RunOverrides,
  remote: boolean,
): JobConfig => {
  const {
    datasets: _datasets,
    tasks: _tasks,
    ...rest
  } = structuredClone(job) as JobConfig & {
    datasets?: unknown;
    tasks?: unknown;
  };
  const config: JobConfig = {
    ...rest,
    datasets: [
      {
        path: tasks,
        ...(overrides.tasks?.length ? { task_names: overrides.tasks } : {}),
      },
    ],
  };
  if (remote) {
    // Trials run in Laminar sandboxes; provider-specific settings don't apply.
    const {
      type: _type,
      import_path: _importPath,
      kwargs: _kwargs,
      ...environment
    } = (config.environment as Record<string, unknown> | undefined) ?? {};
    config.environment = {
      ...environment,
      import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH,
    };
  }
  if (overrides.nAttempts !== undefined)
    config.n_attempts = overrides.nAttempts;
  if (overrides.nConcurrent !== undefined) {
    config.n_concurrent_trials = overrides.nConcurrent;
  }
  // Harbor's default agent is `oracle`; materialize it so overrides apply.
  if (
    !Array.isArray(config.agents) &&
    (overrides.model || overrides.extraAgentEnv?.length)
  ) {
    config.agents = [{ name: "oracle" }];
  }
  for (const agent of asRecords(config.agents)) {
    if (overrides.model) agent.model_name = overrides.model;
    if (overrides.extraAgentEnv?.length) {
      const env = { ...((agent.env as Record<string, string>) ?? {}) };
      for (const key of overrides.extraAgentEnv) {
        env[key] ??= `\${${key}}`;
      }
      agent.env = env;
    }
  }
  return config;
};

export interface TemplateVars {
  /** Referenced without a default: must be set. */
  required: Set<string>;
  /** Referenced with `:-default`: passed along when set. */
  optional: Set<string>;
}

export const collectTemplates = (text: string, into: TemplateVars) => {
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    (match[2] === undefined ? into.required : into.optional).add(match[1]);
  }
};

/** `${VAR}` names referenced by a set's eval.yaml and its run tasks' task.toml files. */
export const findTemplateVars = async (
  setDir: string,
  tasks: string,
  overrides: RunOverrides,
  into: TemplateVars = { required: new Set(), optional: new Set() },
): Promise<TemplateVars> => {
  collectTemplates(
    await readFile(path.join(setDir, EVAL_CONFIG), "utf8").catch(() => ""),
    into,
  );
  for (const dir of await findTaskDirs(tasks, overrides.tasks)) {
    collectTemplates(await readFile(path.join(dir, "task.toml"), "utf8"), into);
  }
  for (const name of into.required) into.optional.delete(name);
  return into;
};

/**
 * Make sure `<set>/.gitignore` lists `tasks/`: tasks live in Laminar, and a
 * committed working copy would win over the eval.yaml pin.
 */
export const ignoreTasks = async (setDir: string): Promise<void> => {
  const file = path.join(setDir, ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const forms = [TASKS_DIR, `${TASKS_DIR}/`, `/${TASKS_DIR}`, `/${TASKS_DIR}/`];
  if (lines.some((l) => forms.includes(l))) return;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${text}${sep}${TASKS_DIR}/\n`);
};

/** What a local task set copy is based on: written by pull and push. */
export interface TaskSetState {
  versionId: string;
  number: number;
  hash: string;
  /** Task name → digest at that version. */
  tasks: Record<string, string>;
  /** Other top-level entry (README, shared data) → digest at that version. */
  files?: Record<string, string>;
}

export const readState = async (
  setDir: string,
): Promise<TaskSetState | null> => {
  const text = await readFile(path.join(setDir, STATE_FILE), "utf8").catch(
    () => null,
  );
  if (text === null) return null;
  try {
    const state = JSON.parse(text) as TaskSetState;
    return typeof state?.versionId === "string" ? state : null;
  } catch {
    return null;
  }
};

export const writeState = async (
  setDir: string,
  state: TaskSetState,
): Promise<void> => {
  await writeFile(
    path.join(setDir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

export const dirExists = isDir;
