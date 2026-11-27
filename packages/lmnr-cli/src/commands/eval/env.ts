import path from "node:path";

import { InvalidArgumentError } from "commander";

import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { missingEnv } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import {
  findTemplateVars,
  type RunOverrides,
  type TemplateVars,
} from "./datasets";
import type { EvalDescription } from "./eval-py";

const logger = initializeLogger();

export const API_KEY_VAR = "LMNR_PROJECT_API_KEY";
const RYSTIC_TOKEN = "RYSTIC_TOKEN";
/** A Rystic mirror's service `kind` in describe (lmnr's `display_name`). */
const RYSTIC_KIND = "Rystic";

/**
 * What a secret variable reads as in a Laminar Agent sandbox; its outbound
 * proxy fills in the headers that carry it.
 */
export const SANDBOX_PROXY_PLACEHOLDER = "injected-by-laminar-sandbox-proxy";

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
 * The `--env` values with `RYSTIC_TOKEN` handled. A Rystic mirror pulls its
 * twin with the user's own Rystic key on local runs, so when a selected
 * eval.py dataset has one, `RYSTIC_TOKEN` is resolved like `--env
 * RYSTIC_TOKEN` (shell, then `.env.local`, `.env`) unless `--env` already
 * set it, and is missing → `missing_env` before anything is built. Remote
 * runs never send it: Laminar gives each trial its own token, which a user
 * value would replace, so `--env RYSTIC_TOKEN` is dropped with a warning.
 */
export const withRysticToken = async (
  explicitEnv: Record<string, string>,
  runners: Record<string, EvalDescription>,
  remote: boolean,
): Promise<Record<string, string>> => {
  if (remote) {
    if (!(RYSTIC_TOKEN in explicitEnv)) return explicitEnv;
    logger.warn(
      `Not sending --env ${RYSTIC_TOKEN}: remote runs get their own Rystic ` +
        "token from Laminar.",
    );
    const { [RYSTIC_TOKEN]: _dropped, ...rest } = explicitEnv;
    return rest;
  }
  const usesRystic = Object.values(runners).some((r) =>
    (r.services ?? []).some((s) => s.kind === RYSTIC_KIND),
  );
  if (!usesRystic || RYSTIC_TOKEN in explicitEnv) return explicitEnv;
  const found = await findEnvKey(process.cwd(), RYSTIC_TOKEN);
  if (!found) {
    throw missingEnv(
      "Rystic mirrors need Rystic access in local (not `--remote`) runs. " +
        `Set ${RYSTIC_TOKEN} to your Rystic API key (in your shell, ` +
        ".env.local or .env).",
    );
  }
  return { ...explicitEnv, [RYSTIC_TOKEN]: found.value };
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
 * The run's env: values for every `${VAR}` the datasets reference, plus the
 * `--env` values (which win). Fails when a required one is unset.
 */
export const resolveRunEnv = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
  explicitEnv: Record<string, string>,
): Promise<Record<string, string>> => {
  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  for (const dataset of datasets) {
    const found = await findTemplateVars(
      path.join(evalsDir, dataset),
      overrides,
    );
    for (const name of found.required) vars.required.add(name);
    for (const name of found.optional) vars.optional.add(name);
  }
  const { env, missing } = await resolveTemplateEnv(vars, process.cwd());
  const stillMissing = missing.filter((name) => !(name in explicitEnv));
  if (stillMissing.length > 0) {
    throw missingEnv(
      `The datasets reference unset variables: ${stillMissing.join(", ")}. ` +
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
