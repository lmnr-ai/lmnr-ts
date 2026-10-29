import path from "node:path";

import { InvalidArgumentError } from "commander";

import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { missingEnv } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { findTemplateVars, type TemplateVars } from "./suites";

export const API_KEY_VAR = "LMNR_PROJECT_API_KEY";

/**
 * Turn repeatable `--env` flags into an env map. `KEY=VALUE` is taken as-is; a
 * bare `KEY` is read from the current environment, so secrets stay out of
 * shell history.
 */
export const parseEnvFlags = (
  entries: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const key = eq === -1 ? entry : entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new InvalidArgumentError(
        `Invalid --env "${key}": expected KEY=VALUE or KEY (a variable name).`,
      );
    }
    if (eq !== -1) {
      out[key] = entry.slice(eq + 1);
      continue;
    }
    const value = env[key];
    if (value === undefined) {
      throw new InvalidArgumentError(
        `--env ${key}: ${key} is not set in the environment. ` +
          `Export it or pass --env ${key}=<value>.`,
      );
    }
    out[key] = value;
  }
  return out;
};

/**
 * Values for `${VAR}` placeholders: the process env first, then `.env.local` /
 * `.env` in `cwd`. Only referenced names are read, never whole files.
 */
export const resolveTemplateEnv = async (
  vars: TemplateVars,
  cwd: string,
): Promise<{ env: Record<string, string>; missing: string[] }> => {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of [...vars.required, ...vars.optional].sort()) {
    const found = await findEnvKey(cwd, name);
    if (found) env[name] = found.value;
    else if (vars.required.has(name)) missing.push(name);
  }
  return { env, missing };
};

/**
 * The run's env: values for every `${VAR}` the suites reference, plus the
 * `--env` values (which win). Fails when a required one is unset.
 */
export const resolveRunEnv = async (
  evalsDir: string,
  suites: string[],
  explicitEnv: Record<string, string>,
): Promise<Record<string, string>> => {
  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  for (const suite of suites) {
    const found = await findTemplateVars(path.join(evalsDir, suite));
    for (const name of found.required) vars.required.add(name);
    for (const name of found.optional) vars.optional.add(name);
  }
  const { env, missing } = await resolveTemplateEnv(vars, process.cwd());
  const stillMissing = missing.filter((name) => !(name in explicitEnv));
  if (stillMissing.length > 0) {
    throw missingEnv(
      `The suites reference unset variables: ${stillMissing.join(", ")}. ` +
        "Export them, add them to .env, or pass --env KEY=VALUE.",
    );
  }
  return { ...env, ...explicitEnv };
};

const projectKey = async (): Promise<string> => {
  const found = await findEnvKey(process.cwd(), API_KEY_VAR);
  if (!found) {
    throw missingEnv(
      `${API_KEY_VAR} is not set. Results are reported with a project API ` +
        "key: run `lmnr-cli setup` to write one to .env, or export it.",
    );
  }
  return found.value;
};

/**
 * The Laminar API URL as the Python SDK reads it (`LMNR_BASE_URL`, port
 * inline). An explicit port replaces one already in the URL, as in
 * `LaminarClient`, so a `.env` with both doesn't yield `host:8000:8000`.
 */
export const laminarBaseUrl = (opts: GlobalOpts): string => {
  const base = resolveBaseUrl(opts.baseUrl).replace(/\/+$/, "");
  const port = opts.port ?? envHttpPort();
  return port ? `${base.replace(/:\d{1,5}$/, "")}:${port}` : base;
};

/**
 * The Harbor process env: the run's env plus the project key and API URL the
 * Laminar plugin (and remote trials' environment class) report with.
 */
export const harborEnv = async (
  env: Record<string, string>,
  opts: GlobalOpts,
): Promise<Record<string, string>> => ({
  ...env,
  [API_KEY_VAR]: await projectKey(),
  LMNR_BASE_URL: laminarBaseUrl(opts),
});
