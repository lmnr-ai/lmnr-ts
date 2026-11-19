import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { harborFailed } from "../../errors";
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
import { type DatasetImages, datasetImages, type RemoteImages } from "./images";
import { type CommandOutput, runCommand } from "./run-command";

const logger = initializeLogger();

/**
 * Harbor and the Laminar plugin are pinned so a dataset behaves the same on a
 * laptop, in CI and in a remote run's orchestrator, and because
 * `lmnr_hosted_env.py` subclasses Harbor's `BaseEnvironment`, whose API moves
 * between releases.
 */
export const HARBOR_VERSION = "0.25.0";
export const LMNR_PYTHON_VERSION = "0.9.2";
const PYTHON_VERSION = "3.13";
const ENVIRONMENT_MODULE = "lmnr_hosted_env.py";
/** In the staging dir: `{<task dir name>: {name, hash}}` for the plugin. */
const TASK_HASHES_FILE = "task-hashes.json";

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
}

/** `group` names the evaluation group: the dataset name, else the folder. */
export const harborArgs = (
  configPath: string,
  group: string,
  { grpcPort, dataset }: PluginArgs = {},
): string[] => [
  "--python",
  PYTHON_VERSION,
  "--from",
  `harbor==${HARBOR_VERSION}`,
  "--with",
  `lmnr==${LMNR_PYTHON_VERSION}`,
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
  // The plugin exports spans over gRPC (8443 unless told otherwise).
  ...(grpcPort ? ["--pk", `grpc_port=${grpcPort}`] : []),
];

interface HarborRun {
  /** The evaluation group: the dataset name, else the folder. */
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
      harborArgs(configPath, run.group, { grpcPort: run.grpcPort, dataset }),
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
  /** Called once the dataset's `harbor run` exits, whether it passed or not. */
  onDatasetEnd: (dataset: string, jobsDir: string) => Promise<void>;
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
 * Run each dataset with Harbor in turn. With `images`, trials run in Laminar
 * sandboxes; without, on local Docker. Returns the datasets that failed.
 */
export const runDatasets = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
  env: Record<string, string>,
  images?: RemoteImages,
  { jobs, output, taskHashes }: DatasetHooks = {},
): Promise<string[]> => {
  const grpcPort = (await findEnvKey(process.cwd(), "LMNR_GRPC_PORT"))?.value;
  const failed: string[] = [];
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const config = buildJobConfig(
      await loadDatasetConfig(datasetDir),
      overrides,
      images !== undefined,
    );
    if (jobs) config.jobs_dir = path.join(jobs.dir, dataset);
    logger.info(
      `Running dataset ${dataset} ${images ? "in Laminar sandboxes" : "on local Docker"}`,
    );
    const manifest = await readDatasetToml(datasetDir);
    const code = await runHarborDataset({
      group: manifest?.name ?? dataset,
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
      failed.push(dataset);
    }
    await jobs?.onDatasetEnd(dataset, path.join(jobs.dir, dataset));
  }
  return failed;
};

/** Fail the command when any dataset's `harbor run` failed. */
export const assertDatasetsPassed = (failed: string[]): void => {
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
};
