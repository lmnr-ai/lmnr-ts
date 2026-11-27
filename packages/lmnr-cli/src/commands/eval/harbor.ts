import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml } from "smol-toml";

import { harborFailed, invalidEvalsDir, trialsErrored } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import { scanTasks, type TaskHashFile, taskHashFile } from "./dataset-state";
import { readDatasetToml } from "./dataset-toml";
import {
  buildJobConfig,
  type JobConfig,
  loadDatasetConfig,
  type RunOverrides,
} from "./datasets";
import {
  evalDescription,
  evalPyPath,
  hasEvalPy,
  parseScriptDependencies,
} from "./eval-py";
import {
  type DatasetImages,
  datasetImages,
  generatedDockerfiles,
  type RemoteImages,
} from "./images";
import {
  jobDirNames,
  newJobDir,
  readTrialOutcomes,
  type TrialOutcomes,
} from "./jobs";
import { type CommandOutput, runCommand } from "./run-command";

const logger = initializeLogger();

/**
 * Harbor and the Laminar plugin are pinned so a dataset behaves the same on a
 * laptop, in CI and in a remote run's orchestrator, and because
 * `lmnr_hosted_env.py` subclasses Harbor's `BaseEnvironment`, whose API moves
 * between releases.
 */
export const HARBOR_VERSION = "0.25.0";
export const LMNR_PYTHON_VERSION = "0.9.3";
export const PYTHON_VERSION = "3.13";
const ENVIRONMENT_MODULE = "lmnr_hosted_env.py";
/** In the staging dir: `{<task dir name>: {name, hash}}` for the plugin. */
const TASK_HASHES_FILE = "task-hashes.json";

/**
 * The `lmnr` requirement next to Harbor and for describing eval.py.
 * `LMNR_EVAL_LMNR_SPEC` (undocumented, for development) replaces it, e.g.
 * with a checkout (`/path/to/lmnr-python`) or `lmnr @ git+https://...@branch`.
 */
export const lmnrSpec = (): string =>
  process.env.LMNR_EVAL_LMNR_SPEC?.trim() || `lmnr==${LMNR_PYTHON_VERSION}`;

/** In the evals root: what code in the Harbor process imports. */
const EVALS_PYPROJECT = "pyproject.toml";

/**
 * The evals root's `pyproject.toml`, if it has a `[project]` table (uv needs
 * one; a file with only tool settings is left alone).
 */
const evalsPyproject = async (
  datasetDir: string,
): Promise<string | undefined> => {
  const file = path.join(
    path.dirname(path.resolve(datasetDir)),
    EVALS_PYPROJECT,
  );
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(text);
  } catch (error) {
    throw invalidEvalsDir(`${file} is not valid TOML: ${errorMessage(error)}`);
  }
  const project = toml.project;
  return typeof project === "object" &&
    project !== null &&
    !Array.isArray(project)
    ? file
    : undefined;
};

/**
 * `uvx` arguments for the packages code in the Harbor process imports
 * (eval.py and its `verify()`, shared runners, custom agents): the evals
 * root's `pyproject.toml` `[project] dependencies` (`--with-requirements`;
 * uv reads only those, not dependency groups or `requires-python`), then an
 * eval.py's PEP 723 `dependencies` (`--with` each). Packages the app or a
 * container script needs belong in the image instead.
 */
export const pythonRequirements = async (
  datasetDir: string,
): Promise<string[]> => {
  const args: string[] = [];
  const pyproject = await evalsPyproject(datasetDir);
  if (pyproject) args.push("--with-requirements", pyproject);
  if (await hasEvalPy(datasetDir)) {
    const file = evalPyPath(datasetDir);
    for (const dep of parseScriptDependencies(
      await readFile(file, "utf8"),
      file,
    )) {
      args.push("--with", dep);
    }
  }
  return args;
};

/** `assets/` next to `dist/` when bundled, three levels up in the source tree. */
const environmentModulePath = (): string => {
  for (const candidate of [
    path.join(__dirname, "..", "assets", ENVIRONMENT_MODULE),
    path.join(__dirname, "..", "..", "..", "assets", ENVIRONMENT_MODULE),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${ENVIRONMENT_MODULE} is missing from the lmnr-cli package`);
};

interface PluginArgs {
  /** Self-hosted Laminar's gRPC port, for the plugin's trace export. */
  grpcPort?: string;
  /**
   * The eval dataset (`[dataset] name`) and its task hashes file; with them
   * the plugin records the dataset and each trial's task and version.
   */
  dataset?: { name: string; taskHashesFile: string };
  /** More packages for the Harbor process (`pythonRequirements`). */
  requirements?: string[];
  /** An eval.py runner's module files, for the Files view (`runner_modules`). */
  runnerModules?: string[];
}

/** `group` names the evaluation group: `--group`, else the dataset name, else the folder. */
export const harborArgs = (
  configPath: string,
  group: string,
  { grpcPort, dataset, requirements = [], runnerModules = [] }: PluginArgs = {},
): string[] => [
  "--python",
  PYTHON_VERSION,
  "--from",
  `harbor==${HARBOR_VERSION}`,
  "--with",
  lmnrSpec(),
  ...requirements,
  "harbor",
  "run",
  "-c",
  configPath,
  "--yes",
  "--plugin",
  "laminar",
  "--pk",
  `group_name=${group}`,
  ...(dataset
    ? [
        "--pk",
        `dataset=${dataset.name}`,
        "--pk",
        `task_hashes_file=${dataset.taskHashesFile}`,
      ]
    : []),
  ...(runnerModules.length > 0
    ? ["--pk", `runner_modules=${JSON.stringify(runnerModules)}`]
    : []),
  // The plugin exports spans over gRPC (8443 unless told otherwise).
  ...(grpcPort ? ["--pk", `grpc_port=${grpcPort}`] : []),
];

interface HarborRun {
  /** The evaluation group: `--group`, else the dataset name, else the folder. */
  group: string;
  datasetDir: string;
  config: JobConfig;
  /** Env for the Harbor process; `${VAR}` placeholders resolve against it. */
  env: Record<string, string>;
  /**
   * Set for remote trials: the pushed images `lmnr_hosted_env.py` starts
   * sandboxes from.
   */
  images?: DatasetImages;
  /** Self-hosted Laminar's gRPC port, for the plugin's trace export. */
  grpcPort?: string;
  /** The eval dataset's name and task hashes; unset without a dataset.toml. */
  dataset?: { name: string; taskHashes: TaskHashFile };
  /** Gets Harbor's output as well as our stderr. */
  output?: CommandOutput;
}

/**
 * Run one dataset with `harbor run` from inside the dataset dir, so relative
 * paths in harbor.yaml (datasets, jobs_dir) and custom agent imports resolve
 * the same way everywhere. Returns Harbor's exit code.
 */
const runHarborDataset = async (run: HarborRun): Promise<number> => {
  const staging = await mkdtemp(path.join(tmpdir(), "lmnr-eval-"));
  try {
    const configPath = path.join(staging, "job.json");
    await writeFile(configPath, JSON.stringify(run.config, null, 2), {
      mode: 0o600,
    });
    if (run.images) {
      await copyFile(
        environmentModulePath(),
        path.join(staging, ENVIRONMENT_MODULE),
      );
    }
    let dataset: PluginArgs["dataset"];
    if (run.dataset) {
      const taskHashesFile = path.join(staging, TASK_HASHES_FILE);
      await writeFile(taskHashesFile, JSON.stringify(run.dataset.taskHashes));
      dataset = { name: run.dataset.name, taskHashesFile };
    }
    const pythonPath = [staging, run.datasetDir, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter);
    return await runCommand(
      "uvx",
      harborArgs(configPath, run.group, {
        grpcPort: run.grpcPort,
        dataset,
        requirements: await pythonRequirements(run.datasetDir),
        runnerModules: (await hasEvalPy(run.datasetDir))
          ? evalDescription(run.datasetDir).modules
          : [],
      }),
      {
        cwd: run.datasetDir,
        env: {
          ...process.env,
          ...run.env,
          PYTHONPATH: pythonPath,
          ...(run.images
            ? { LMNR_EVAL_IMAGES: JSON.stringify(run.images) }
            : {}),
        },
        output: run.output,
      },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/** Where each dataset's Harbor job is written, and what happens to it after. */
export interface JobOutput {
  /**
   * Dataset `d` writes its job under `<dir>/<d>`, whatever its harbor.yaml
   * says. The job keeps its own name: the Laminar plugin names the evaluation
   * after it.
   */
  dir: string;
  /**
   * Called once the dataset's `harbor run` exits, whether it passed or not,
   * with the job it wrote (`undefined` when Harbor wrote none).
   */
  onDatasetEnd: (dataset: string, jobDir: string | undefined) => Promise<void>;
}

/** What a remote run's orchestrator hooks into its datasets' Harbor runs. */
export interface DatasetHooks {
  jobs?: JobOutput;
  /**
   * Where each dataset's Harbor output also goes (it still goes to our stderr
   * too). Both sinks end when the dataset's `harbor run` exits.
   */
  output?: (dataset: string) => CommandOutput;
  /**
   * Task hashes by dataset folder, when already known (a remote run's spec);
   * other datasets with a dataset.toml have their tasks hashed before they
   * run.
   */
  taskHashes?: Record<string, TaskHashFile>;
}

/**
 * Write a dataset's generated Dockerfiles (`generatedDockerfiles`) into its
 * local job dir, next to Harbor's `config.json`, as `<image>.Dockerfile`:
 * files, since Harbor's tools count every dir in a job dir as a trial.
 */
const keepGeneratedDockerfiles = async (
  dataset: string,
  jobDir: string | undefined,
  dockerfiles: Record<string, string>,
): Promise<void> => {
  const names = Object.keys(dockerfiles);
  if (!jobDir || names.length === 0) return;
  try {
    for (const name of names) {
      await writeFile(path.join(jobDir, name), dockerfiles[name]);
    }
  } catch (error) {
    logger.warn(
      `Could not keep the generated Dockerfiles of dataset ${dataset} in ` +
        `${jobDir}: ${errorMessage(error)}`,
    );
    return;
  }
  logger.info(
    `Generated Dockerfile(s) of dataset ${dataset}: ` +
      names.map((name) => path.join(jobDir, name)).join(", "),
  );
};

/** How a run's datasets ended. */
export interface DatasetsOutcome {
  /** Datasets whose `harbor run` failed. */
  failed: string[];
  /**
   * Every dataset's trials, from its Harbor job's trial results; `jobDir` for
   * local runs.
   */
  trials: Record<string, TrialOutcomes & { jobDir?: string }>;
}

const describeError = ({ firstError }: TrialOutcomes): string => {
  if (!firstError) return "";
  const line = firstError.message.trim().split("\n")[0];
  const message = line.length > 300 ? `${line.slice(0, 300)}...` : line;
  return `${firstError.type}${message ? `: ${message}` : ""}`;
};

/**
 * Run each dataset with Harbor in turn. With `images`, trials run in Laminar
 * sandboxes; without, on local Docker. Logs `N/M trials errored` for each
 * dataset with errored trials.
 */
export const runDatasets = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
  env: Record<string, string>,
  images?: RemoteImages,
  { jobs, output, taskHashes }: DatasetHooks = {},
): Promise<DatasetsOutcome> => {
  const grpcPort = (await findEnvKey(process.cwd(), "LMNR_GRPC_PORT"))?.value;
  const outcome: DatasetsOutcome = { failed: [], trials: {} };
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const config = buildJobConfig(
      await loadDatasetConfig(datasetDir),
      overrides,
      images !== undefined,
    );
    if (jobs) config.jobs_dir = path.join(jobs.dir, dataset);
    // Local runs keep the generated Dockerfiles they built in the job dir.
    const generated = images
      ? {}
      : await generatedDockerfiles(datasetDir, overrides);
    const jobsDir = path.resolve(
      datasetDir,
      typeof config.jobs_dir === "string" ? config.jobs_dir : "jobs",
    );
    const jobsBefore = await jobDirNames(jobsDir);
    logger.info(
      `Running dataset ${dataset} ${images ? "in Laminar sandboxes" : "on local Docker"}`,
    );
    const manifest = await readDatasetToml(datasetDir);
    const code = await runHarborDataset({
      group: overrides.group ?? manifest?.name ?? dataset,
      datasetDir,
      config,
      env,
      images: images && datasetImages(images, dataset),
      grpcPort,
      // The plugin links trials to Laminar's task versions by these.
      dataset: manifest
        ? {
            name: manifest.name,
            taskHashes:
              taskHashes?.[dataset] ??
              (await taskHashFile(datasetDir, await scanTasks(datasetDir))),
          }
        : undefined,
      output: output?.(dataset),
    });
    if (code !== 0) {
      logger.error(`harbor run failed for dataset ${dataset} (exit ${code})`);
      outcome.failed.push(dataset);
    }
    const jobDir = await newJobDir(jobsDir, jobsBefore, config.job_name);
    const trials = await readTrialOutcomes(jobDir);
    // A remote trial's job dir is deleted with its sandbox: no use naming it.
    outcome.trials[dataset] =
      jobDir && !images ? { ...trials, jobDir } : trials;
    if (trials.errored > 0) {
      logger.warn(
        `Dataset ${dataset}: ${trials.errored}/${trials.total} trials ` +
          `errored (first: ${describeError(trials)})`,
      );
    }
    await keepGeneratedDockerfiles(dataset, jobDir, generated);
    await jobs?.onDatasetEnd(dataset, jobDir);
  }
  return outcome;
};

/**
 * Fail the command when any dataset's `harbor run` failed (18), else when
 * every trial of a dataset errored (23): nothing was graded, so the
 * evaluation says nothing about the agent. Some errored trials only warn
 * (`runDatasets`).
 */
export const assertDatasetsPassed = ({
  failed,
  trials,
}: DatasetsOutcome): void => {
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
  const broken = Object.entries(trials).filter(
    ([, t]) => t.total > 0 && t.errored === t.total,
  );
  if (broken.length > 0) {
    throw trialsErrored(
      "Every trial errored, so nothing was graded, in: " +
        broken
          .map(
            ([dataset, t]) =>
              `${dataset} (${t.total} trials; first: ${describeError(t)}` +
              (t.jobDir ? `; each trial's exception.txt in ${t.jobDir}` : "") +
              ")",
          )
          .join("; "),
    );
  }
};
