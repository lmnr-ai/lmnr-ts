import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { harborFailed } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import { type RemoteImages, type SuiteImages, suiteImages } from "./images";
import { runCommand } from "./run-command";
import {
  buildJobConfig,
  type JobConfig,
  loadSuiteConfig,
  type RunOverrides,
} from "./suites";

const logger = initializeLogger();

/**
 * Harbor and the Laminar plugin are pinned so a suite behaves the same on a
 * laptop, in CI and in a detached run's orchestrator, and because
 * `lmnr_hosted_env.py` subclasses Harbor's `BaseEnvironment`, whose API moves
 * between releases.
 */
export const HARBOR_VERSION = "0.25.0";
export const LMNR_PYTHON_VERSION = "0.8.3";
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
  suite: string,
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
  `group_name=${suite}`,
  // The plugin exports spans over gRPC (8443 unless told otherwise).
  ...(grpcPort ? ["--pk", `grpc_port=${grpcPort}`] : []),
];

interface HarborRun {
  suite: string;
  suiteDir: string;
  config: JobConfig;
  /** Env for the Harbor process; `${VAR}` placeholders resolve against it. */
  env: Record<string, string>;
  /**
   * Set for remote trials: the pushed images `lmnr_hosted_env.py` starts
   * sandboxes from.
   */
  images?: SuiteImages;
  /** Self-hosted Laminar's gRPC port, for the plugin's trace export. */
  grpcPort?: string;
}

/**
 * Run one suite with `harbor run` from inside the suite dir, so relative paths
 * in harbor.yaml (datasets, jobs_dir) and custom agent imports resolve the
 * same way everywhere. Returns Harbor's exit code.
 */
const runHarborSuite = async (run: HarborRun): Promise<number> => {
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
    const pythonPath = [staging, run.suiteDir, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter);
    return await runCommand(
      "uvx",
      harborArgs(configPath, run.suite, run.grpcPort),
      {
        cwd: run.suiteDir,
        env: {
          ...process.env,
          ...run.env,
          PYTHONPATH: pythonPath,
          ...(run.images
            ? { LMNR_EVAL_IMAGES: JSON.stringify(run.images) }
            : {}),
        },
      },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/**
 * Run each suite with Harbor in turn. With `images`, trials run in Laminar
 * sandboxes; without, on local Docker. Returns the suites that failed.
 */
export const runSuites = async (
  evalsDir: string,
  suites: string[],
  overrides: RunOverrides,
  env: Record<string, string>,
  images?: RemoteImages,
): Promise<string[]> => {
  const grpcPort = (await findEnvKey(process.cwd(), "LMNR_GRPC_PORT"))?.value;
  const failed: string[] = [];
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const config = buildJobConfig(
      await loadSuiteConfig(suiteDir),
      overrides,
      images !== undefined,
    );
    logger.info(
      `Running suite ${suite} ${images ? "in Laminar sandboxes" : "on local Docker"}`,
    );
    const code = await runHarborSuite({
      suite,
      suiteDir,
      config,
      env,
      images: images && suiteImages(images, suite),
      grpcPort,
    });
    if (code !== 0) {
      logger.error(`harbor run failed for suite ${suite} (exit ${code})`);
      failed.push(suite);
    }
  }
  return failed;
};

/** Fail the command when any suite's `harbor run` failed. */
export const assertSuitesPassed = (failed: string[]): void => {
  if (failed.length > 0) {
    throw harborFailed(`harbor run failed for: ${failed.join(", ")}`);
  }
};
