import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";

/** A dataset is a directory directly inside the evals folder holding a Harbor JobConfig. */
const DATASET_CONFIG = "harbor.yaml";
/** The dataset's tasks, synced with Laminar by `eval push` / `eval pull`. */
export const TASKS_DIR = "tasks";
/** Optional per-dataset config: the images its tasks reference by `docker_image`. */
export const IMAGES_CONFIG = "lmnr.yaml";

/**
 * Never walked into: VCS data, dependency/build caches and Harbor job output.
 * Not packed for upload (`pack.ts`), not hashed (`tasks.ts`) and not searched
 * for datasets.
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

export interface RunOverrides {
  tasks?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  /** `--env` names: referenced as `${KEY}` from every agent's env. */
  extraAgentEnv?: string[];
}

export type JobConfig = Record<string, unknown>;

/** One dataset of a run: its folder and the evaluation group it reports to. */
export interface DatasetRun {
  /** The dataset folder, relative to the evals folder. */
  path: string;
  /** `<dataset> v<N>` or `<dataset> unversioned` (`sync.ts` `groupName`). */
  group: string;
}

export const isFile = (file: string) =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

/** Dataset directory names directly inside `dir`, sorted. */
export const discoverDatasets = async (dir: string): Promise<string[]> => {
  const root = path.resolve(dir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw invalidEvalsDir(`Evals folder not found: ${root}`);
  }
  if (await isFile(path.join(root, IMAGES_CONFIG))) {
    throw invalidEvalsDir(
      `${path.join(root, IMAGES_CONFIG)} is no longer read: image definitions ` +
        `are per dataset now. Move its images into <dataset>/${IMAGES_CONFIG} ` +
        "of each dataset that uses them (dockerfile and context paths are " +
        "relative to the dataset folder), then delete it.",
    );
  }
  const entries = await readdir(root, { withFileTypes: true });
  const datasets: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
    if (await isFile(path.join(root, entry.name, DATASET_CONFIG))) {
      datasets.push(entry.name);
    }
  }
  if (datasets.length === 0) {
    throw invalidEvalsDir(
      `No datasets in ${root}: expected <dataset>/${DATASET_CONFIG} directly ` +
        "inside it. Pass the evals folder itself, not its parent or a dataset.",
    );
  }
  return datasets.sort();
};

/** The datasets `--dataset` names (all of them when omitted), validated. */
export const selectDatasets = async (
  evalsDir: string,
  requested: string[] | undefined,
): Promise<string[]> => {
  const datasets = await discoverDatasets(evalsDir);
  if (!requested?.length) return datasets;
  const unknown = requested.filter((s) => !datasets.includes(s));
  if (unknown.length > 0) {
    throw invalidEvalsDir(
      `Unknown --dataset ${unknown.join(", ")}. ` +
        `Datasets in ${evalsDir}: ${datasets.join(", ")}`,
    );
  }
  return [...new Set(requested)];
};

/**
 * The dataset's harbor.yaml with the dataset's own `tasks/` folder as its one
 * Harbor dataset. harbor.yaml must not pick tasks itself: a dataset's tasks
 * are what `eval push` versions.
 */
export const loadDatasetConfig = async (
  datasetDir: string,
): Promise<JobConfig> => {
  const file = path.join(datasetDir, DATASET_CONFIG);
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${String(error)}`);
  }
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw invalidEvalsDir(`${file} must be a mapping (a Harbor JobConfig).`);
  }
  const config = (parsed ?? {}) as JobConfig;
  const picked = ["datasets", "tasks"].filter((key) => key in config);
  if (picked.length > 0) {
    throw invalidEvalsDir(
      `${file} sets ${picked.map((k) => `\`${k}\``).join(" and ")}: remove ` +
        `${picked.length > 1 ? "them" : "it"}. A dataset runs the tasks in ` +
        `its own ${TASKS_DIR}/ folder; lmnr-cli adds ` +
        `\`datasets: [{path: ${TASKS_DIR}}]\` itself. Use --task to run some ` +
        "of them, and a separate dataset folder for other tasks.",
    );
  }
  return { ...config, datasets: [{ path: TASKS_DIR }] };
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

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> => typeof v === "object" && !!v,
      )
    : [];

/**
 * Apply CLI overrides to a dataset's JobConfig (from `loadDatasetConfig`), and
 * with `remote` route trials to Laminar sandboxes. `harbor run` flags can't override a `-c` config's datasets
 * (`-i` requires `-p`) and `-m` only applies with `-a`, so overrides are
 * written into the config instead.
 */
export const buildJobConfig = (
  config: JobConfig,
  overrides: RunOverrides,
  remote: boolean,
): JobConfig => {
  const job: JobConfig = structuredClone(config);
  if (remote) {
    // Trials run in Laminar sandboxes; provider-specific settings don't apply.
    const {
      type: _type,
      import_path: _importPath,
      kwargs: _kwargs,
      ...rest
    } = (job.environment as Record<string, unknown> | undefined) ?? {};
    job.environment = { ...rest, import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH };
  }
  if (overrides.nAttempts !== undefined) job.n_attempts = overrides.nAttempts;
  if (overrides.nConcurrent !== undefined) {
    job.n_concurrent_trials = overrides.nConcurrent;
  }
  const tasks = overrides.tasks;
  if (tasks?.length) {
    for (const dataset of asRecords(job.datasets)) {
      dataset.task_names = tasks;
    }
  }
  // Harbor's default agent is `oracle`; materialize it so overrides apply.
  if (
    !Array.isArray(job.agents) &&
    (overrides.model || overrides.extraAgentEnv?.length)
  ) {
    job.agents = [{ name: "oracle" }];
  }
  for (const agent of asRecords(job.agents)) {
    if (overrides.model) agent.model_name = overrides.model;
    if (overrides.extraAgentEnv?.length) {
      const env = { ...((agent.env as Record<string, string>) ?? {}) };
      for (const key of overrides.extraAgentEnv) {
        env[key] ??= `\${${key}}`;
      }
      agent.env = env;
    }
  }
  return job;
};

export interface TemplateVars {
  /** Referenced without a default: must be set. */
  required: Set<string>;
  /** Referenced with `:-default`: passed along when set. */
  optional: Set<string>;
}

const collectTemplates = (text: string, into: TemplateVars) => {
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    (match[2] === undefined ? into.required : into.optional).add(match[1]);
  }
};

/**
 * The `task.toml` of every task the dataset's run includes, as Harbor resolves
 * its `tasks/` dataset (`JobPlan.resolve_task_configs`): child dirs holding a
 * `task.toml`, matched by name against `--task` globs (`task_names`). A linked
 * task dir is followed and named after its target, as Harbor does.
 */
export const findTaskTomls = async (
  datasetDir: string,
  overrides: RunOverrides,
): Promise<string[]> => {
  const include = (overrides.tasks ?? []).map(globToRegExp);
  const root = path.join(datasetDir, TASKS_DIR);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const tomls: string[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    // Harbor follows linked task dirs and names them after the target
    // (`LocalTaskId.get_name` resolves the path).
    let name = entry.name;
    if (entry.isSymbolicLink()) {
      const target = await realpath(dir).catch(() => null);
      if (!target) continue;
      name = path.basename(target);
    } else if (!entry.isDirectory()) {
      continue;
    }
    if (include.length > 0 && !include.some((p) => p.test(name))) continue;
    const toml = path.join(dir, "task.toml");
    if (await isFile(toml)) tomls.push(toml);
  }
  return tomls.sort();
};

/** `${VAR}` names referenced by the dataset's harbor.yaml and its tasks' task.toml files. */
export const findTemplateVars = async (
  datasetDir: string,
  overrides: RunOverrides,
): Promise<TemplateVars> => {
  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  collectTemplates(
    await readFile(path.join(datasetDir, DATASET_CONFIG), "utf8"),
    vars,
  );
  for (const file of await findTaskTomls(datasetDir, overrides)) {
    collectTemplates(await readFile(file, "utf8"), vars);
  }
  for (const name of vars.required) vars.optional.delete(name);
  return vars;
};
