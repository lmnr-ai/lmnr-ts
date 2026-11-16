import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { version } from "../../../package.json";
import { missingEnv } from "../../errors";
import { onStderr } from "../../utils/command-capture";
import { initializeLogger } from "../../utils/logger";
import { imagePusher } from "./docker";
import { API_KEY_VAR, harborEnv } from "./env";
import {
  assertTaskSetsPassed,
  type JobOutput,
  runTaskSets,
  type TaskSetRun,
} from "./harbor";
import { ensureRemoteImages, type RemoteImages } from "./images";
import { findJobDir, packJobDir } from "./jobs";
import { loadAgentConfig, type RunOverrides, taskSetDir } from "./layout";
import { createRunLogShipper } from "./run-log";
import { harborLogLine } from "./run-log-lines";
import { downloadBlob } from "./store";

const logger = initializeLogger();

/** A version a run uses: its id and its blob's hash. */
export interface VersionRef {
  name: string;
  versionId: string;
  hash: string;
}

/**
 * A remote run, written here and read back by `eval orchestrate` in the
 * orchestrator sandbox, which runs this same CLI version.
 */
export interface RunSpec extends RemoteImages {
  agent: VersionRef;
  taskSets: VersionRef[];
  overrides: RunOverrides;
  /** Values for the `${VAR}` placeholders and `--env` flags. */
  env: Record<string, string>;
}

/** An agent ready to run: its scripts and task sets, local or downloaded. */
export interface PreparedAgent {
  agent: VersionRef;
  /** Where its scripts are. */
  dir: string;
  taskSets: (VersionRef & { dir: string })[];
}

/** The Harbor runs of a prepared agent, one per task set. */
export const taskSetRuns = async (
  prepared: PreparedAgent,
): Promise<TaskSetRun[]> => {
  const { job } = await loadAgentConfig(prepared.dir);
  return prepared.taskSets.map((set) => ({
    agent: prepared.agent.name,
    agentDir: prepared.dir,
    agentVersionId: prepared.agent.versionId,
    job,
    taskSet: set.name,
    setDir: set.dir,
    taskSetVersionId: set.versionId,
  }));
};

/**
 * Push the agent's images and start its run in an orchestrator sandbox. Its
 * versions are already in Laminar (the run snapshotted them). Returns once that
 * sandbox has started.
 */
export const startRemoteRun = async (
  client: LaminarClient,
  prepared: PreparedAgent,
  overrides: RunOverrides,
  env: Record<string, string>,
): Promise<{ runId: string; sandboxId: string }> => {
  // The orchestrator gets its own short-lived key and URL from the server.
  const dropped = Object.keys(env).filter((k) => k.startsWith("LMNR_"));
  const runEnv = Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith("LMNR_")),
  );
  if (dropped.length > 0) {
    logger.warn(
      `Not sending ${dropped.join(", ")}: remote runs report with their own key.`,
    );
  }
  const { images: defs } = await loadAgentConfig(prepared.dir);
  const images = await ensureRemoteImages(
    defs,
    prepared.taskSets.map((s) => s.dir),
    overrides,
    imagePusher(client),
  );
  const spec: RunSpec = {
    agent: prepared.agent,
    taskSets: prepared.taskSets.map(({ name, versionId, hash }) => ({
      name,
      versionId,
      hash,
    })),
    overrides,
    env: runEnv,
    ...images,
  };
  return client.hostedEvals.startRun({ cliVersion: version, spec });
};

const readRunSpec = (): RunSpec => {
  const raw = process.env.LMNR_EVAL_RUN;
  if (!raw) throw missingEnv("LMNR_EVAL_RUN is not set.");
  let spec: Partial<RunSpec> | null;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    throw missingEnv(`LMNR_EVAL_RUN is not valid JSON: ${errorMessage(error)}`);
  }
  if (!spec?.agent || !Array.isArray(spec.taskSets)) {
    throw missingEnv("LMNR_EVAL_RUN is not a run spec: no agent or task sets.");
  }
  return spec as RunSpec;
};

/**
 * Each task set's Harbor job goes to Laminar once it ends, for the trial log
 * view: the sandbox, and the job dir with it, is deleted after the run. A
 * failed upload only warns.
 */
const jobUploads = async (
  client: LaminarClient,
  runId: string,
): Promise<JobOutput> => ({
  dir: await mkdtemp(path.join(tmpdir(), "lmnr-jobs-")),
  onTaskSetEnd: async (taskSet, jobsDir) => {
    const jobDir = await findJobDir(jobsDir);
    if (!jobDir) return;
    try {
      const { archive, index, skipped } = await packJobDir(jobDir);
      if (skipped.length > 0) {
        logger.warn(
          `Not uploading ${skipped.length} large trial file(s) of task set ` +
            `${taskSet}: ${skipped.slice(0, 5).join(", ")}` +
            (skipped.length > 5 ? ", ..." : ""),
        );
      }
      await client.hostedEvals.uploadJob(runId, taskSet, archive);
      await client.hostedEvals.uploadJobIndex(runId, taskSet, {
        files: index,
      });
    } catch (error) {
      logger.warn(
        `Could not upload the trial logs of task set ${taskSet}: ` +
          errorMessage(error),
      );
    }
  },
});

/** Download the run's agent scripts and task sets under `root/<agent>/`. */
const materialize = async (
  client: LaminarClient,
  spec: RunSpec,
  root: string,
): Promise<PreparedAgent> => {
  const dir = path.join(root, spec.agent.name);
  await downloadBlob(client, spec.agent.hash, dir);
  const taskSets = [];
  for (const set of spec.taskSets) {
    const setDir = taskSetDir(dir, set.name);
    await downloadBlob(client, set.hash, setDir);
    taskSets.push({ ...set, dir: setDir });
  }
  return { agent: spec.agent, dir, taskSets };
};

/**
 * `lmnr-cli eval orchestrate` (hidden): the remote run's entry point inside
 * its orchestrator sandbox. Downloads the run's agent scripts and task sets
 * into `$LMNR_EVALS_ROOT`, then runs each task set; the spec, run id, project
 * key and API URL come from the env the app-server set.
 *
 * Everything the run prints (this CLI's log, Harbor's output) also goes to the
 * run's log in Laminar, which `eval run --remote` follows. Once a line is
 * stored, `$LMNR_RUN_LOG_MARKER` is created: the sandbox's command then sends
 * only the exit code, not its own tail of the output.
 */
export const handleEvalOrchestrate = async (): Promise<void> => {
  const spec = readRunSpec();
  const runId = process.env.LMNR_EVAL_RUN_ID;
  if (!runId) throw missingEnv("LMNR_EVAL_RUN_ID is not set.");
  const env = await harborEnv(spec.env, {});
  const client = new LaminarClient({
    baseUrl: env.LMNR_BASE_URL,
    auth: { type: "apiKey", key: env[API_KEY_VAR] },
  });
  const marker = process.env.LMNR_RUN_LOG_MARKER;
  const shipper = createRunLogShipper(
    (lines) => client.hostedEvals.appendRunLogs(runId, lines),
    // Sync: a run that fails fast exits right after its first batch.
    marker ? () => writeFileSync(marker, "") : undefined,
  );
  const unsubscribe = onStderr(shipper.writer().write);
  const links = new Set<string>();
  try {
    const root = process.env.LMNR_EVALS_ROOT || process.cwd();
    const prepared = await materialize(client, spec, root);
    const failed = await runTaskSets(
      await taskSetRuns(prepared),
      spec.overrides,
      // Rich wraps at 80 columns off a terminal, splitting paths and links.
      { ...env, COLUMNS: "500" },
      { images: spec.images },
      {
        runId,
        jobs: await jobUploads(client, runId),
        output: (label) => {
          const rewrite = harborLogLine(label, links);
          return {
            stdout: shipper.writer(rewrite),
            stderr: shipper.writer(rewrite),
          };
        },
      },
    );
    assertTaskSetsPassed(failed);
  } catch (error) {
    // The caller logs it and exits right away, before a flush could run.
    shipper.writer().write(`ERROR: ${errorMessage(error)}\n`);
    throw error;
  } finally {
    unsubscribe();
    await shipper.close();
  }
};
