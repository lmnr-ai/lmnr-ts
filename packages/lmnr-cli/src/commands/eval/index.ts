import { stat } from "node:fs/promises";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";

import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import {
  harborFailed,
  invalidEvalsDir,
  remoteRunFailed,
  trialsErrored,
} from "../../errors";
import { pc } from "../../utils/colors";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { buildEvalClient, checkProjectKey } from "./client";
import { checkRunTasks, readDatasetFolders } from "./dataset-command";
import {
  DATASET_CONFIG,
  discoverDatasets,
  isRunnableDataset,
  type RunOverrides,
} from "./datasets";
import { describeDatasets } from "./describe";
import { buildLocalImages } from "./docker";
import {
  harborEnv,
  parseEnvFlags,
  resolveRunEnv,
  withRysticToken,
} from "./env";
import { EVAL_PY } from "./eval-py";
import {
  assertDatasetsPassed,
  type DatasetsOutcome,
  runDatasets,
} from "./harbor";
import { LEGACY_IMAGES_FILE, localImageDefs } from "./images";
import { startRemoteRun } from "./remote";
import { type FollowResult, followRunLog } from "./run-log";
import { type EvaluationLink, parseEvaluationLine } from "./run-log-lines";
import { ensureTaskFiles, logTaskFileChanges } from "./task-files";

const logger = initializeLogger();

interface EvalRunOpts extends GlobalOpts {
  dir: string;
  remote?: boolean;
  task?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  env?: string[];
  group?: string;
}

/** Commander parser for `--group`. */
export const parseGroupName = (raw: string): string => {
  const group = raw.trim();
  if (!group) throw new InvalidArgumentError("Must not be empty.");
  return group;
};

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
 * it must have a harbor.yaml or an agent/eval.py), else every runnable one.
 */
export const selectDatasets = async (
  evalsDir: string,
  requested: string | undefined,
): Promise<string[]> => {
  if (!requested) return discoverDatasets(evalsDir);
  if (await isRunnableDataset(path.join(evalsDir, requested))) {
    return [requested];
  }
  const named = (await readDatasetFolders(evalsDir)).find(
    (f) => f.manifest?.name === requested,
  );
  if (named && (await isRunnableDataset(path.join(evalsDir, named.folder)))) {
    return [named.folder];
  }
  const known = await discoverDatasets(evalsDir).catch(() => []);
  throw invalidEvalsDir(
    `Unknown dataset ${requested}: no ${DATASET_CONFIG} or ${EVAL_PY} in ` +
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
  outcome: DatasetsOutcome,
  opts: GlobalOpts,
) => {
  const url = await evaluationsUrl(opts.projectId);
  if (opts.json) {
    outputJson({
      mode: "local",
      datasets,
      failed: outcome.failed,
      // Per dataset: {total, errored, firstError?: {type, message}, jobDir?}.
      trials: outcome.trials,
      url,
    });
  } else if (url) {
    logger.info(`Results are in evaluations: ${url}`);
  }
  assertDatasetsPassed(outcome);
};

/** Exit codes `eval orchestrate` ends with that mean "a dataset failed". */
const HARBOR_FAILED_EXIT = 18;
const TRIALS_ERRORED_EXIT = 23;

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
  if (result.exitCode === TRIALS_ERRORED_EXIT) {
    throw trialsErrored(
      "Every trial of a dataset of the remote run errored, so nothing was " +
        "graded; see its log above.",
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
    logger.info(`Results are in evaluations: ${url}`);
  }
  assertRemotePassed(result);
};

/**
 * `lmnr-cli eval run [dataset]`: run Harbor datasets locally on Docker
 * (default), or with `--remote` in Laminar sandboxes, following the run's log
 * until it ends. Runs the tasks on disk as they are: nothing is pulled first
 * (`eval dataset pull` does that), it only warns when they lag dataset.toml.
 */
export const handleEvalRun = async (
  dataset: string | undefined,
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const flagEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const evalsDir = path.resolve(opts.dir);
  const datasets = await selectDatasets(evalsDir, dataset);
  if (opts.group && datasets.length > 1) {
    // One group per dataset: two datasets' runs in one group would be charted
    // as one series.
    throw new InvalidArgumentError(
      `--group names one dataset's runs, but ${evalsDir} has ` +
        `${datasets.length} (${datasets.join(", ")}). Name the dataset to run.`,
    );
  }
  await warnLegacyImageFiles(evalsDir, datasets);
  // eval.py datasets: read each runner, then write the task files Harbor
  // needs that tasks lack, before anything hashes or packs them.
  const runners = await describeDatasets(evalsDir, datasets);
  const explicitEnv = await withRysticToken(
    flagEnv,
    runners,
    opts.remote === true,
  );
  for (const [folder, description] of Object.entries(runners)) {
    logTaskFileChanges(
      folder,
      await ensureTaskFiles(path.join(evalsDir, folder), description),
    );
  }
  // Runs the tasks on disk as they are; `eval dataset pull` syncs them.
  const taskHashes = await checkRunTasks(evalsDir, datasets, opts.task, opts);

  const overrides: RunOverrides = {
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    extraAgentEnv: Object.keys(explicitEnv),
    group: opts.group,
  };
  const env = await resolveRunEnv(evalsDir, datasets, overrides, explicitEnv);

  if (!opts.remote) {
    const runEnv = await harborEnv(env, opts);
    // Before minutes of builds and trials whose results would go nowhere.
    await checkProjectKey(runEnv);
    await buildLocalImages(await localImageDefs(evalsDir, datasets, overrides));
    const outcome = await runDatasets(
      evalsDir,
      datasets,
      overrides,
      runEnv,
      undefined,
      { taskHashes },
    );
    await reportLocal(datasets, outcome, opts);
    return;
  }

  const remote = await buildEvalClient(opts);
  const run = await startRemoteRun(
    remote,
    evalsDir,
    datasets,
    overrides,
    env,
    taskHashes,
    runners,
  );
  await followRemote(remote, run, datasets, opts);
};
