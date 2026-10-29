import path from "node:path";

import { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";

import { version } from "../../../package.json";
import { buildLaminarClient } from "../../auth/client";
import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import {
  archiveTooLarge,
  harborFailed,
  invalidEvalsDir,
  missingEnv,
} from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { buildLocalImages, runHarborSuite } from "./harbor";
import { ensureRemoteImages, type ImageMap, loadImageDefs } from "./images";
import { discoverSuites, packEvalsDir } from "./pack";
import { buildAndPushImage, dockerAvailable } from "./push";
import {
  buildJobConfig,
  findTemplateVars,
  loadSuiteConfig,
  type RunOverrides,
  type TemplateVars,
} from "./suites";

const logger = initializeLogger();

/** The server's cap on the uploaded archive (`MAX_ARCHIVE_BYTES`). */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const API_KEY_VAR = "LMNR_PROJECT_API_KEY";

interface EvalRunOpts extends GlobalOpts {
  remote?: boolean;
  attach?: boolean;
  suite?: string[];
  task?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  env?: string[];
}

/**
 * A detached run, written here and read back by `eval orchestrate` in the
 * orchestrator sandbox, which runs this same CLI version.
 */
export interface RunSpec {
  suites: string[];
  overrides: Omit<RunOverrides, "remote">;
  /** Values for the suites' `${VAR}` placeholders and `--env` flags. */
  env: Record<string, string>;
  images: Record<string, ImageMap>;
}

/** Commander parser for `--n-attempts` / `--n-concurrent`. */
export const parsePositiveInt = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
};

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
      throw new Error(
        `Invalid --env "${key}": expected KEY=VALUE or KEY (a variable name).`,
      );
    }
    if (eq !== -1) {
      out[key] = entry.slice(eq + 1);
      continue;
    }
    const value = env[key];
    if (value === undefined) {
      throw new Error(
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

/**
 * Images for Laminar sandboxes. With Docker, `lmnr.yaml` images are built here
 * and pushed layer by layer, so a change re-uploads and rebuilds only the
 * layers it touches; without it, Laminar builds them from the uploaded context.
 */
const remoteImages = async (
  client: LaminarClient,
  evalsDir: string,
  suites: string[],
): Promise<Record<string, ImageMap>> => {
  if (await dockerAvailable()) {
    return ensureRemoteImages(client, evalsDir, suites, (def) =>
      buildAndPushImage(client, def),
    );
  }
  if ((await loadImageDefs(evalsDir)).length > 0) {
    logger.warn(
      "Docker isn't available, so Laminar builds the lmnr.yaml images from " +
        "their build context: any change in it rebuilds the whole image. " +
        "Start Docker to build here and upload only changed layers.",
    );
  }
  return ensureRemoteImages(client, evalsDir, suites);
};

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Run each suite with Harbor in turn. With `images`, trials run in Laminar
 * sandboxes; without, on local Docker. Returns the suites that failed.
 */
const runSuites = async (
  evalsDir: string,
  suites: string[],
  overrides: RunOverrides,
  env: Record<string, string>,
  images?: Record<string, ImageMap>,
): Promise<string[]> => {
  const grpcPort = (await findEnvKey(process.cwd(), "LMNR_GRPC_PORT"))?.value;
  const failed: string[] = [];
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const config = buildJobConfig(await loadSuiteConfig(suiteDir), overrides);
    logger.info(
      `Running suite ${suite} ${images ? "in Laminar sandboxes" : "on local Docker"}`,
    );
    const code = await runHarborSuite({
      suite,
      suiteDir,
      config,
      env,
      images: images?.[suite],
      grpcPort,
    });
    if (code !== 0) {
      logger.error(`harbor run failed for suite ${suite} (exit ${code})`);
      failed.push(suite);
    }
  }
  return failed;
};

const reportAttached = async (
  mode: "local" | "remote",
  suites: string[],
  failed: string[],
  opts: GlobalOpts,
) => {
  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({ mode, suites, failed, url });
  } else if (url) {
    logger.info(`Results are in evaluations grouped by suite: ${url}`);
  }
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
};

/**
 * `lmnr-cli eval run [dir]`: run Harbor suites locally on Docker (default), or
 * with `--remote` in Laminar sandboxes, detached unless `--attach`.
 */
export const handleEvalRun = async (
  dir: string,
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const explicitEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const evalsDir = path.resolve(dir);
  const suites = await selectSuites(evalsDir, opts.suite);

  const vars: TemplateVars = { required: new Set(), optional: new Set() };
  for (const suite of suites) {
    const found = await findTemplateVars(path.join(evalsDir, suite));
    for (const name of found.required) vars.required.add(name);
    for (const name of found.optional) vars.optional.add(name);
  }
  const { env: templateEnv, missing } = await resolveTemplateEnv(
    vars,
    process.cwd(),
  );
  const stillMissing = missing.filter((name) => !(name in explicitEnv));
  if (stillMissing.length > 0) {
    throw missingEnv(
      `The suites reference unset variables: ${stillMissing.join(", ")}. ` +
        "Export them, add them to .env, or pass --env KEY=VALUE.",
    );
  }
  const env = { ...templateEnv, ...explicitEnv };
  const overrides: Omit<RunOverrides, "remote"> = {
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    extraAgentEnv: Object.keys(explicitEnv),
  };

  if (!opts.remote) {
    if (opts.attach) {
      throw new Error("--attach only applies with --remote.");
    }
    const harborEnv = {
      ...env,
      [API_KEY_VAR]: await projectKey(),
      LMNR_BASE_URL: laminarBaseUrl(opts),
    };
    await buildLocalImages(await loadImageDefs(evalsDir));
    const failed = await runSuites(
      evalsDir,
      suites,
      { ...overrides, remote: false },
      harborEnv,
    );
    await reportAttached("local", suites, failed, opts);
    return;
  }

  const client = await buildRemoteClient(opts);
  if (opts.attach) {
    const harborEnv = {
      ...env,
      [API_KEY_VAR]: await projectKey(),
      LMNR_BASE_URL: laminarBaseUrl(opts),
    };
    const images = await remoteImages(client, evalsDir, suites);
    const failed = await runSuites(
      evalsDir,
      suites,
      { ...overrides, remote: true },
      harborEnv,
      images,
    );
    await reportAttached("remote", suites, failed, opts);
    return;
  }

  await startDetachedRun(client, evalsDir, suites, overrides, env, opts);
};

const startDetachedRun = async (
  client: LaminarClient,
  evalsDir: string,
  suites: string[],
  overrides: Omit<RunOverrides, "remote">,
  env: Record<string, string>,
  opts: EvalRunOpts,
) => {
  // The orchestrator gets its own short-lived key and URL from the server.
  const dropped = Object.keys(env).filter((k) => k.startsWith("LMNR_"));
  const runEnv = Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith("LMNR_")),
  );
  if (dropped.length > 0) {
    logger.warn(
      `Not sending ${dropped.join(", ")}: detached runs report with their own key.`,
    );
  }

  const images = await remoteImages(client, evalsDir, suites);
  const { archive, fileCount, skippedSymlinks } = await packEvalsDir(evalsDir);
  if (skippedSymlinks.length > 0) {
    logger.warn(
      `Skipped ${skippedSymlinks.length} symlink(s): ` +
        skippedSymlinks.slice(0, 5).join(", ") +
        (skippedSymlinks.length > 5 ? ", ..." : ""),
    );
  }
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw archiveTooLarge(
      `Packed evals folder is ${formatMiB(archive.length)}, over the ` +
        `${formatMiB(MAX_ARCHIVE_BYTES)} limit. Remove large files (datasets, ` +
        "build output) from the folder.",
    );
  }

  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `suites: ${suites.join(", ")}`,
  );
  const { uploadId } = await client.hostedEvals.upload(archive);
  const spec: RunSpec = { suites, overrides, env: runEnv, images };
  const { sandboxId } = await client.hostedEvals.startRun({
    uploadId,
    cliVersion: version,
    spec: spec as unknown as Record<string, unknown>,
  });

  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({ mode: "detached", uploadId, sandboxId, suites, url });
    return;
  }
  logger.info(`Started detached run in sandbox ${sandboxId}`);
  if (url) {
    logger.info(`Results appear in evaluations grouped by suite: ${url}`);
  }
};

/**
 * `lmnr-cli eval orchestrate` (hidden): the detached run's entry point inside
 * its orchestrator sandbox. The evals folder is the cwd; the spec, project key
 * and API URL come from the env the app-server set.
 */
export const handleEvalOrchestrate = async (): Promise<void> => {
  const raw = process.env.LMNR_EVAL_RUN;
  if (!raw) throw missingEnv("LMNR_EVAL_RUN is not set.");
  const spec = JSON.parse(raw) as RunSpec;
  const harborEnv = {
    ...spec.env,
    [API_KEY_VAR]: await projectKey(),
    LMNR_BASE_URL: laminarBaseUrl({}),
  };
  const failed = await runSuites(
    process.cwd(),
    spec.suites,
    { ...spec.overrides, remote: true },
    harborEnv,
    spec.images,
  );
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
};
