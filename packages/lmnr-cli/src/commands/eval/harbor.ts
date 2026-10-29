import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

import { harborFailed, missingTool } from "../../errors";
import { type ImageDef, type ImageMap, stageBuildContext } from "./images";
import type { JobConfig } from "./suites";

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

/** Exit code of `command`, with its output on our stderr (stdout stays data-only). */
export const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", 2, 2],
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? missingTool(`\`${command}\` is not installed or not on PATH.`)
          : error,
      );
    });
    child.on("close", (code) => resolve(code ?? 1));
  });

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

export interface HarborRun {
  suite: string;
  suiteDir: string;
  config: JobConfig;
  /** Env for the Harbor process; `${VAR}` placeholders resolve against it. */
  env: Record<string, string>;
  /** Set for remote trials: the images `lmnr_hosted_env.py` builds from. */
  images?: ImageMap;
  /** Self-hosted Laminar's gRPC port, for the plugin's trace export. */
  grpcPort?: string;
}

/**
 * Run one suite with `harbor run` from inside the suite dir, so relative paths
 * in harbor.yaml (datasets, jobs_dir) and custom agent imports resolve the
 * same way everywhere. Returns Harbor's exit code.
 */
export const runHarborSuite = async (run: HarborRun): Promise<number> => {
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
 * Build `lmnr.yaml` images locally, tagged with the name tasks reference. An
 * image with `include` builds from a staged copy of just those paths.
 */
export const buildLocalImages = async (defs: ImageDef[]): Promise<void> => {
  for (const def of defs) {
    const context = def.include ? await stageBuildContext(def) : def.context;
    try {
      const code = await runCommand("docker", [
        "build",
        "-f",
        def.dockerfile,
        "-t",
        def.name,
        context,
      ]);
      if (code !== 0) {
        throw harborFailed(
          `docker build of image ${def.name} failed (${code}).`,
        );
      }
    } finally {
      if (def.include) await rm(context, { recursive: true, force: true });
    }
  }
};
