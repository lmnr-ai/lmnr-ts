import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { harborFailed } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import type { RemoteImages } from "./images";
import { buildJobConfig, type JobConfig, type RunOverrides } from "./layout";
import { type CommandOutput, runCommand } from "./run-command";

const logger = initializeLogger();

/**
 * Harbor and the Laminar plugin are pinned so a task set behaves the same on a
 * laptop, in CI and in a remote run's orchestrator, and because
 * `lmnr_hosted_env.py` subclasses Harbor's `BaseEnvironment`, whose API moves
 * between releases.
 */
export const HARBOR_VERSION = "0.25.0";
export const LMNR_PYTHON_VERSION = "0.8.10";
const PYTHON_VERSION = "3.13";
const ENVIRONMENT_MODULE = "lmnr_hosted_env.py";

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

export const harborArgs = (
  configPath: string,
  group: string,
  grpcPort?: string,
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
  // The plugin exports spans over gRPC (8443 unless told otherwise).
  ...(grpcPort ? ["--pk", `grpc_port=${grpcPort}`] : []),
];

/** One task set of one agent, ready to run: what a Harbor run and its evaluation are. */
export interface TaskSetRun {
  agent: string;
  /** The agent's scripts; Harbor runs from here. */
  agentDir: string;
  agentVersionId: string;
  /** agent.yaml's `job`. */
  job: JobConfig;
  taskSet: string;
  /** The task set's files, wherever they are (local copy or downloaded). */
  setDir: string;
  taskSetVersionId: string;
}

/** `<agent>/<task set>`: the evaluation group and the label in logs. */
export const runLabel = (run: Pick<TaskSetRun, "agent" | "taskSet">) =>
  `${run.agent}/${run.taskSet}`;

/**
 * Env that links the evaluation the Laminar Harbor plugin creates to the agent
 * and task set versions it ran (and, remotely, to the run).
 */
export const linkEnv = (
  run: TaskSetRun,
  runId?: string,
): Record<string, string> => ({
  LMNR_EVAL_AGENT_VERSION_ID: run.agentVersionId,
  LMNR_EVAL_TASK_SET_VERSION_ID: run.taskSetVersionId,
  LMNR_EVAL_TASK_SET_ROOT: run.setDir,
  HARBOR_LAMINAR_GROUP: runLabel(run),
  ...(runId ? { LMNR_EVAL_RUN_ID: runId } : {}),
});

interface HarborRun {
  label: string;
  cwd: string;
  config: JobConfig;
  /** Env for the Harbor process; `${VAR}` placeholders resolve against it. */
  env: Record<string, string>;
  /** Set for remote trials: the pushed images `lmnr_hosted_env.py` starts sandboxes from. */
  images?: RemoteImages;
  /** Self-hosted Laminar's gRPC port, for the plugin's trace export. */
  grpcPort?: string;
  /** Gets Harbor's output as well as our stderr. */
  output?: CommandOutput;
}

/**
 * Run one task set with `harbor run` from inside the agent dir, so relative
 * paths in agent.yaml (jobs_dir) and custom agent imports resolve the same way
 * everywhere. Returns Harbor's exit code.
 */
const runHarbor = async (run: HarborRun): Promise<number> => {
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
    const pythonPath = [staging, run.cwd, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter);
    return await runCommand(
      "uvx",
      harborArgs(configPath, run.label, run.grpcPort),
      {
        cwd: run.cwd,
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

/** Where each task set's Harbor job is written, and what happens to it after. */
export interface JobOutput {
  /**
   * Task set `s` writes its job under `<dir>/<s>`, whatever agent.yaml says.
   * The job keeps its own name: the Laminar plugin names the evaluation after it.
   */
  dir: string;
  /** Called once the task set's `harbor run` exits, whether it passed or not. */
  onTaskSetEnd: (taskSet: string, jobsDir: string) => Promise<void>;
}

/** What a remote run's orchestrator hooks into its Harbor runs. */
export interface RunHooks {
  /** Set in a remote run's orchestrator; links its evaluations to the run. */
  runId?: string;
  jobs?: JobOutput;
  /**
   * Where each task set's Harbor output also goes (it still goes to our stderr
   * too). Both sinks end when its `harbor run` exits.
   */
  output?: (label: string) => CommandOutput;
}

/**
 * Run each task set with Harbor in turn. With `images`, trials run in Laminar
 * sandboxes; without, on local Docker. Returns the labels of the failed ones.
 */
export const runTaskSets = async (
  runs: TaskSetRun[],
  overrides: RunOverrides,
  env: Record<string, string>,
  images?: RemoteImages,
  { runId, jobs, output }: RunHooks = {},
): Promise<string[]> => {
  const grpcPort = (await findEnvKey(process.cwd(), "LMNR_GRPC_PORT"))?.value;
  const failed: string[] = [];
  for (const run of runs) {
    const label = runLabel(run);
    const config = buildJobConfig(
      run.job,
      run.setDir,
      overrides,
      images !== undefined,
    );
    if (jobs) config.jobs_dir = path.join(jobs.dir, run.taskSet);
    logger.info(
      `Running task set ${label} ${images ? "in Laminar sandboxes" : "on local Docker"}`,
    );
    const code = await runHarbor({
      label,
      cwd: run.agentDir,
      config,
      env: { ...env, ...linkEnv(run, runId) },
      images,
      grpcPort,
      output: output?.(label),
    });
    if (code !== 0) {
      logger.error(`harbor run failed for task set ${label} (exit ${code})`);
      failed.push(label);
    }
    await jobs?.onTaskSetEnd(run.taskSet, path.join(jobs.dir, run.taskSet));
  }
  return failed;
};

/** Fail the command when any task set's `harbor run` failed. */
export const assertTaskSetsPassed = (failed: string[]): void => {
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
};
