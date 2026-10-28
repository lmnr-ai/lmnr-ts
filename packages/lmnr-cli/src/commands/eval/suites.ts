import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";
import { SUITE_CONFIG } from "./pack";

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
  remote: boolean;
}

export type JobConfig = Record<string, unknown>;

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
 * Apply CLI overrides to a suite's JobConfig. `harbor run` flags can't override
 * a `-c` config's datasets (`-i` requires `-p`) and `-m` only applies with
 * `-a`, so overrides are written into the config instead.
 */
export const buildJobConfig = (
  config: JobConfig,
  overrides: RunOverrides,
): JobConfig => {
  const job: JobConfig = structuredClone(config);
  if (overrides.remote) {
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

/** Every `task.toml` under `suiteDir` (skipping job output and caches). */
export const findTaskTomls = async (suiteDir: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          ["jobs", ".git", "node_modules", "__pycache__", ".venv"].includes(
            entry.name,
          )
        ) {
          continue;
        }
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "task.toml") {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  await walk(suiteDir);
  return found.sort();
};

/** `${VAR}` names referenced by the suite's harbor.yaml and task.toml files. */
export const findTemplateVars = async (
  suiteDir: string,
): Promise<TemplateVars> => {
  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  collectTemplates(
    await readFile(path.join(suiteDir, SUITE_CONFIG), "utf8"),
    vars,
  );
  for (const file of await findTaskTomls(suiteDir)) {
    collectTemplates(await readFile(file, "utf8"), vars);
  }
  for (const name of vars.required) vars.optional.delete(name);
  return vars;
};
