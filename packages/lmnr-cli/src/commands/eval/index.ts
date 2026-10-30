import path from "node:path";

import { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";

import { buildLaminarClient } from "../../auth/client";
import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { invalidEvalsDir } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { buildLocalImages } from "./docker";
import { API_KEY_VAR, harborEnv, parseEnvFlags, resolveRunEnv } from "./env";
import { assertSuitesPassed, runSuites } from "./harbor";
import { localImageDefs } from "./images";
import { startRemoteRun } from "./remote";
import { discoverSuites, type RunOverrides } from "./suites";

const logger = initializeLogger();

interface EvalRunOpts extends GlobalOpts {
  remote?: boolean;
  suite?: string[];
  task?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  env?: string[];
}

/** Commander parser for `--n-attempts` / `--n-concurrent`. */
export const parsePositiveInt = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
};

const selectSuites = async (
  evalsDir: string,
  requested: string[] | undefined,
): Promise<string[]> => {
  const suites = await discoverSuites(evalsDir);
  if (!requested?.length) return suites;
  const unknown = requested.filter((s) => !suites.includes(s));
  if (unknown.length > 0) {
    throw invalidEvalsDir(
      `Unknown --suite ${unknown.join(", ")}. ` +
        `Suites in ${evalsDir}: ${suites.join(", ")}`,
    );
  }
  return requested;
};

/**
 * Remote runs call the API as the logged-in user, or with the project API key
 * when there is no login (CI).
 */
const buildRemoteClient = async (opts: GlobalOpts): Promise<LaminarClient> => {
  try {
    return await buildLaminarClient({
      projectId: opts.projectId,
      baseUrl: opts.baseUrl,
      port: opts.port,
    });
  } catch (error) {
    const key = await findEnvKey(process.cwd(), API_KEY_VAR);
    if (!key) throw error;
    logger.debug("No CLI login; using LMNR_PROJECT_API_KEY");
    return new LaminarClient({
      baseUrl: resolveBaseUrl(opts.baseUrl),
      port: opts.port ?? envHttpPort(),
      auth: { type: "apiKey", key: key.value },
    });
  }
};

const evaluationsUrl = async (
  projectId: string | undefined,
): Promise<string | undefined> => {
  const id = projectId || (await readLocalProjectFile())?.projectId;
  if (!id) return undefined;
  const frontend =
    process.env.LMNR_FRONTEND_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_FRONTEND_URL;
  return `${frontend}/project/${id}/evaluations`;
};

/** Report a local run once its suites have finished. */
const reportLocal = async (
  suites: string[],
  failed: string[],
  opts: GlobalOpts,
) => {
  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({ mode: "local", suites, failed, url });
  } else if (url) {
    logger.info(`Results are in evaluations grouped by suite: ${url}`);
  }
  assertSuitesPassed(failed);
};

/**
 * `lmnr-cli eval run [dir]`: run Harbor suites locally on Docker (default), or
 * with `--remote` in Laminar sandboxes (the run continues there; the CLI exits).
 */
export const handleEvalRun = async (
  dir: string,
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const explicitEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const evalsDir = path.resolve(dir);
  const suites = await selectSuites(evalsDir, opts.suite);
  const overrides: RunOverrides = {
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    extraAgentEnv: Object.keys(explicitEnv),
  };
  const env = await resolveRunEnv(evalsDir, suites, overrides, explicitEnv);

  if (!opts.remote) {
    const runEnv = await harborEnv(env, opts);
    await buildLocalImages(await localImageDefs(evalsDir, suites, overrides));
    const failed = await runSuites(evalsDir, suites, overrides, runEnv);
    await reportLocal(suites, failed, opts);
    return;
  }

  const client = await buildRemoteClient(opts);
  const { uploadId, sandboxId } = await startRemoteRun(
    client,
    evalsDir,
    suites,
    overrides,
    env,
  );
  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({ mode: "remote", uploadId, sandboxId, suites, url });
    return;
  }
  logger.info(`Started remote run in sandbox ${sandboxId}`);
  if (url) {
    logger.info(`Results appear in evaluations grouped by suite: ${url}`);
  }
};
