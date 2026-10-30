import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";

/** A suite is a directory directly inside the evals folder holding a Harbor JobConfig. */
const SUITE_CONFIG = "harbor.yaml";

/**
 * Never walked into: VCS data, dependency/build caches and Harbor job output.
 * Not packed for upload (`pack.ts`) and not searched for suites.
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

/** Suite directory names directly inside `dir`, sorted. */
export const discoverSuites = async (dir: string): Promise<string[]> => {
  const root = path.resolve(dir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw invalidEvalsDir(`Evals folder not found: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const suites: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
    const config = await stat(path.join(root, entry.name, SUITE_CONFIG)).catch(
      () => null,
    );
    if (config?.isFile()) suites.push(entry.name);
  }
  if (suites.length === 0) {
    throw invalidEvalsDir(
      `No suites in ${root}: expected <suite>/${SUITE_CONFIG} directly ` +
        "inside it. Pass the evals folder itself, not its parent or a suite.",
    );
  }
  return suites.sort();
};

export const loadSuiteConfig = async (suiteDir: string): Promise<JobConfig> => {
  const file = path.join(suiteDir, SUITE_CONFIG);
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${String(error)}`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidEvalsDir(`${file} must be a mapping (a Harbor JobConfig).`);
  }
  return parsed as JobConfig;
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

/** Mirrors Harbor's task ids: registry tasks by name, local/git tasks by directory. */
const taskName = (task: Record<string, unknown>): string =>
  typeof task.name === "string" && task.name
    ? task.name
    : path.basename(typeof task.path === "string" ? task.path : "");

/**
 * Apply CLI overrides to a suite's JobConfig, and with `remote` route trials to
 * Laminar sandboxes. `harbor run` flags can't override a `-c` config's datasets
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
    const patterns = tasks.map(globToRegExp);
    for (const dataset of asRecords(job.datasets)) {
      dataset.task_names = tasks;
    }
    if (Array.isArray(job.tasks)) {
      job.tasks = asRecords(job.tasks).filter((task) =>
        patterns.some((p) => p.test(taskName(task))),
      );
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

const isFile = (file: string) =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

/**
 * The `task.toml` of every local task the suite's run includes, as Harbor
 * resolves them (`JobPlan.resolve_task_configs`): `tasks` entries with a
 * `path`, plus each local dataset's child dirs holding a `task.toml`, matched
 * by name against `task_names` / `exclude_task_names` (`--task` lands in
 * `task_names`). `n_tasks` is ignored: Harbor counts only dirs that pass its
 * full validation, so applying it here could skip a task that runs.
 * Registry and git tasks are fetched by Harbor and not listed.
 */
export const findTaskTomls = async (
  suiteDir: string,
  overrides: RunOverrides,
): Promise<string[]> => {
  const job = buildJobConfig(await loadSuiteConfig(suiteDir), overrides, false);
  const dirs: string[] = [];
  for (const task of asRecords(job.tasks)) {
    if (typeof task.path === "string" && !task.git_url && !task.name) {
      dirs.push(path.resolve(suiteDir, task.path));
    }
  }
  const patterns = (value: unknown) =>
    Array.isArray(value) ? value.map((p) => globToRegExp(String(p))) : [];
  for (const dataset of asRecords(job.datasets)) {
    if (typeof dataset.path !== "string" || dataset.repo || dataset.name) {
      continue;
    }
    const root = path.resolve(suiteDir, dataset.path);
    const include = patterns(dataset.task_names);
    const exclude = patterns(dataset.exclude_task_names);
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (include.length === 0 || include.some((p) => p.test(entry.name))) &&
        !exclude.some((p) => p.test(entry.name))
      ) {
        dirs.push(path.join(root, entry.name));
      }
    }
  }
  const tomls: string[] = [];
  for (const dir of new Set(dirs)) {
    const toml = path.join(dir, "task.toml");
    if (await isFile(toml)) tomls.push(toml);
  }
  return tomls.sort();
};

/** `${VAR}` names referenced by the suite's harbor.yaml and its tasks' task.toml files. */
export const findTemplateVars = async (
  suiteDir: string,
  overrides: RunOverrides,
): Promise<TemplateVars> => {
  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  collectTemplates(
    await readFile(path.join(suiteDir, SUITE_CONFIG), "utf8"),
    vars,
  );
  for (const file of await findTaskTomls(suiteDir, overrides)) {
    collectTemplates(await readFile(file, "utf8"), vars);
  }
  for (const name of vars.required) vars.optional.delete(name);
  return vars;
};
