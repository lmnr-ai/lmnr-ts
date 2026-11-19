import { stat } from "node:fs/promises";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";

import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { harborFailed, invalidEvalsDir, remoteRunFailed } from "../../errors";
import { pc } from "../../utils/colors";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { buildEvalClient } from "./client";
import {
  DEFAULT_EVALS_DIR,
  pullRunTasks,
  readDatasetFolders,
} from "./dataset-command";
import {
  DATASET_CONFIG,
  discoverDatasets,
  type RunOverrides,
} from "./datasets";
import { buildLocalImages } from "./docker";
import { harborEnv, parseEnvFlags, resolveRunEnv } from "./env";
import { assertDatasetsPassed, runDatasets } from "./harbor";
import { LEGACY_IMAGES_FILE, localImageDefs } from "./images";
import { startRemoteRun } from "./remote";
import { type FollowResult, followRunLog } from "./run-log";
import { type EvaluationLink, parseEvaluationLine } from "./run-log-lines";

const logger = initializeLogger();

interface EvalRunOpts extends GlobalOpts {
  dir?: string;
  remote?: boolean;
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

const isFile = (file: string) =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

/**
 * The folder of the requested dataset (a folder name or a `[dataset] name`;
 * it must have a harbor.yaml), else every runnable one.
 */
const selectDatasets = async (
  evalsDir: string,
  requested: string | undefined,
): Promise<string[]> => {
  if (!requested) return discoverDatasets(evalsDir);
  if (await isFile(path.join(evalsDir, requested, DATASET_CONFIG))) {
    return [requested];
  }
  const named = (await readDatasetFolders(evalsDir)).find(
    (f) => f.manifest?.name === requested,
  );
  if (
    named &&
    (await isFile(path.join(evalsDir, named.folder, DATASET_CONFIG)))
  ) {
    return [named.folder];
  }
  const known = await discoverDatasets(evalsDir).catch(() => []);
  throw invalidEvalsDir(
    `Unknown dataset ${requested}: no ${DATASET_CONFIG} in ` +
      `${path.join(evalsDir, requested)}, and no dataset folder with that ` +
      "[dataset] name." +
      (known.length > 0 ? ` Datasets in ${evalsDir}: ${known.join(", ")}` : ""),
  );
};

/** Images used to be declared in `lmnr.yaml`; say so if one is left. */
const warnLegacyImageFiles = async (evalsDir: string, datasets: string[]) => {
  for (const dir of [
    evalsDir,
    ...datasets.map((d) => path.join(evalsDir, d)),
  ]) {
    const file = path.join(dir, LEGACY_IMAGES_FILE);
    if (await isFile(file)) {
      logger.warn(
        `${file} is not read: declare images in each dataset's ` +
          `${DATASET_CONFIG}, under images.`,
      );
    }
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

/** Report a local run once its datasets have finished. */
const reportLocal = async (
  datasets: string[],
  failed: string[],
  opts: GlobalOpts,
) => {
  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({ mode: "local", datasets, failed, url });
  } else if (url) {
    logger.info(`Results are in evaluations grouped by dataset: ${url}`);
  }
  assertDatasetsPassed(failed);
};

/** Exit codes `eval orchestrate` ends with that mean "a dataset failed". */
const HARBOR_FAILED_EXIT = 18;

/** Turn how a followed remote run ended into this command's outcome. */
export const assertRemotePassed = (result: FollowResult) => {
  if (result.kind === "lost") {
    throw remoteRunFailed(
      `The run's orchestrator sandbox is ${result.state}` +
        (result.reason ? ` (${result.reason})` : "") +
        " and never reported how the run ended.",
    );
  }
  if (result.kind !== "exited" || result.exitCode === 0) return;
  if (result.exitCode === HARBOR_FAILED_EXIT) {
    throw harborFailed(
      "A dataset of the remote run failed; see its log above.",
    );
  }
  throw remoteRunFailed(
    `The remote run exited with code ${result.exitCode}; see its log above.`,
  );
};

/** Print a started remote run's log until it ends, then report it. */
const formatLink = ({ dataset, url }: EvaluationLink) =>
  `${pc.bold(`Laminar evaluation for dataset ${dataset}:`)} ${pc.cyan(url)}`;

/** The evaluation links a run printed, once more where they can't scroll away. */
const formatLinks = (links: EvaluationLink[]) =>
  `\n${pc.bold("Results in Laminar:")}\n` +
  links.map(({ dataset, url }) => `  ${dataset}: ${pc.cyan(url)}\n`).join("");

const followRemote = async (
  client: LaminarClient,
  run: { uploadId: string; sandboxId: string },
  datasets: string[],
  opts: GlobalOpts,
) => {
  const url = await evaluationsUrl(opts.projectId);
  logger.info(
    `Started remote run in sandbox ${run.sandboxId}; following its log ` +
      "(Ctrl-C stops following, the run goes on).",
  );
  // Each dataset's evaluation shows up in the log once the run creates it.
  const links: EvaluationLink[] = [];
  const write = (text: string) => {
    const link = parseEvaluationLine(text.trimEnd());
    if (link) links.push(link);
    process.stderr.write(link ? `${formatLink(link)}\n` : text);
  };
  const onInterrupt = () => {
    process.stderr.write("\nStopped following; the run goes on in Laminar.\n");
    if (links.length > 0) process.stderr.write(formatLinks(links));
    else if (url) process.stderr.write(`Results: ${url}\n`);
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  let result: FollowResult;
  try {
    result = await followRunLog(
      client.hostedEvals,
      run.uploadId,
      run.sandboxId,
      { write },
    );
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  if (result.kind === "unsupported") {
    logger.warn(
      "This Laminar server doesn't keep run logs, so the run can't be " +
        "followed here; it goes on in Laminar.",
    );
  }
  if (opts.json) {
    outputJson({
      mode: "remote",
      ...run,
      datasets,
      url,
      evaluations: links,
      exitCode: result.kind === "exited" ? result.exitCode : null,
    });
  } else if (links.length > 0) {
    process.stderr.write(formatLinks(links));
  } else if (url) {
    logger.info(`Results are in evaluations grouped by dataset: ${url}`);
  }
  assertRemotePassed(result);
};

/**
 * `lmnr-cli eval run [dataset]`: run Harbor datasets locally on Docker
 * (default), or with `--remote` in Laminar sandboxes, following the run's log
 * until it ends. Pinned tasks missing from `tasks/` (or unedited with a new
 * pin in dataset.toml) are pulled first.
 */
export const handleEvalRun = async (
  dataset: string | undefined,
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const explicitEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, dataset);
  await warnLegacyImageFiles(evalsDir, datasets);
  let client: LaminarClient | undefined;
  const getClient = async () => {
    client ??= await buildEvalClient(opts);
    return client;
  };
  await pullRunTasks(evalsDir, datasets, opts.task, opts, getClient);

  const overrides: RunOverrides = {
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    extraAgentEnv: Object.keys(explicitEnv),
  };
  const env = await resolveRunEnv(evalsDir, datasets, overrides, explicitEnv);

  if (!opts.remote) {
    const runEnv = await harborEnv(env, opts);
    await buildLocalImages(await localImageDefs(evalsDir, datasets, overrides));
    const failed = await runDatasets(evalsDir, datasets, overrides, runEnv);
    await reportLocal(datasets, failed, opts);
    return;
  }

  const remote = await getClient();
  const run = await startRemoteRun(remote, evalsDir, datasets, overrides, env);
  await followRemote(remote, run, datasets, opts);
};
