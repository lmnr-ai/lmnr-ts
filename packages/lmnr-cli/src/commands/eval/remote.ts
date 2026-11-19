import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { version } from "../../../package.json";
import { archiveTooLarge, missingEnv } from "../../errors";
import { onStderr } from "../../utils/command-capture";
import { initializeLogger } from "../../utils/logger";
import { fetchTasks } from "./dataset-sync";
import { type DatasetRun, type RunOverrides, TASKS_DIR } from "./datasets";
import { imagePusher } from "./docker";
import { API_KEY_VAR, harborEnv } from "./env";
import { assertDatasetsPassed, type JobOutput, runDatasets } from "./harbor";
import { ensureRemoteImages, type RemoteImages } from "./images";
import { findJobDir, packJobDir } from "./jobs";
import { packEvalsDir } from "./pack";
import { createRunLogShipper } from "./run-log";
import { harborLogLine } from "./run-log-lines";
import {
  chunks,
  isValidName,
  MAX_DATASET_NAME,
  TASKS_PER_REQUEST,
} from "./tasks";

const logger = initializeLogger();

/** The server's cap on the uploaded archive (`MAX_ARCHIVE_BYTES`). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/**
 * A remote run, written here and read back by `eval orchestrate` in the
 * orchestrator sandbox, which runs this same CLI version.
 */
interface RunSpec {
  /**
   * Each dataset folder with the hashes of its run's tasks, and the tasks
   * left out of the upload (`tasks`: Laminar has those versions).
   */
  datasets: DatasetRun[];
  overrides: RunOverrides;
  /** Values for the datasets' `${VAR}` placeholders and `--env` flags. */
  env: Record<string, string>;
  /** Pushed image digests, by dataset. */
  images: RemoteImages;
}

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Each dataset's run tasks whose version Laminar already has, as
 * `DatasetRun.tasks`: the upload leaves them out and the orchestrator
 * downloads them. Tasks with unpushed content are uploaded as before. When
 * the check fails (e.g. no eval dataset storage), everything is uploaded.
 */
export const withStoredTasks = async (
  client: LaminarClient,
  datasets: DatasetRun[],
): Promise<DatasetRun[]> => {
  const runs: DatasetRun[] = [];
  for (const run of datasets) {
    const names = Object.keys(run.taskHashes);
    if (!isValidName(run.path, MAX_DATASET_NAME) || names.length === 0) {
      runs.push(run);
      continue;
    }
    const missing = new Set<string>();
    try {
      for (const batch of chunks(names, TASKS_PER_REQUEST)) {
        const tasks = Object.fromEntries(
          batch.map((name) => [name, run.taskHashes[name]]),
        );
        for (const name of await client.evalDatasets.missingTasks(
          run.path,
          tasks,
        )) {
          missing.add(name);
        }
      }
    } catch (error) {
      logger.warn(
        `${run.path}: uploading all its tasks; could not check which ` +
          `Laminar has: ${errorMessage(error)}`,
      );
      runs.push(run);
      continue;
    }
    const stored = names.filter((name) => !missing.has(name));
    runs.push(
      stored.length > 0
        ? {
            ...run,
            tasks: Object.fromEntries(
              stored.map((name) => [name, run.taskHashes[name]]),
            ),
          }
        : run,
    );
  }
  return runs;
};

/**
 * Pack and upload the evals folder, push its images, and start the run in an
 * orchestrator sandbox. Returns once that sandbox has started.
 */
export const startRemoteRun = async (
  client: LaminarClient,
  evalsDir: string,
  runs: DatasetRun[],
  overrides: RunOverrides,
  env: Record<string, string>,
): Promise<{ uploadId: string; sandboxId: string }> => {
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

  const datasets = await withStoredTasks(client, runs);
  const exclude = new Set(
    datasets.flatMap((run) =>
      Object.keys(run.tasks ?? {}).map(
        (task) => `${run.path}/${TASKS_DIR}/${task}`,
      ),
    ),
  );
  if (exclude.size > 0) {
    logger.info(
      `${exclude.size} task(s) are in Laminar already; the run gets them ` +
        "from there",
    );
  }
  // Pack first: a too-large folder fails before minutes of image pushes.
  const { archive, index, fileCount, skippedSymlinks } = await packEvalsDir(
    evalsDir,
    process.platform,
    exclude,
  );
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

  const images = await ensureRemoteImages(
    evalsDir,
    datasets.map((d) => d.path),
    overrides,
    imagePusher(client),
  );
  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `datasets: ${datasets.map((d) => d.path).join(", ")}`,
  );
  const { uploadId } = await client.hostedEvals.upload(archive);
  try {
    await client.hostedEvals.uploadIndex(uploadId, { files: index });
  } catch (error) {
    // Only the file view in Laminar needs it (servers before it answer 404).
    logger.warn(
      `Could not upload the file index, so Laminar won't show this run's ` +
        `files: ${errorMessage(error)}`,
    );
  }
  const spec: RunSpec = { datasets, overrides, env: runEnv, images };
  const { sandboxId } = await client.hostedEvals.startRun({
    uploadId,
    cliVersion: version,
    spec,
  });
  return { uploadId, sandboxId };
};

/**
 * Put the tasks the upload left out (`DatasetRun.tasks`) into each dataset's
 * `tasks/`, from Laminar (run key, `/v1` routes), through the same cache,
 * hash check and install as `eval dataset pull`.
 */
const downloadRunTasks = async (
  client: LaminarClient,
  datasets: DatasetRun[],
) => {
  for (const run of datasets) {
    const tasks = run.tasks ?? {};
    const count = Object.keys(tasks).length;
    if (count === 0) continue;
    logger.info(`${run.path}: getting ${count} task(s) from Laminar`);
    await fetchTasks(
      client,
      run.path,
      path.join(process.cwd(), run.path, TASKS_DIR),
      tasks,
    );
  }
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
  if (!Array.isArray(spec?.datasets)) {
    throw missingEnv("LMNR_EVAL_RUN is not a run spec: it has no datasets.");
  }
  return spec as RunSpec;
};

/**
 * Each dataset's Harbor job goes to Laminar once the dataset ends, for the trial
 * log view: the sandbox, and the job dir with it, is deleted after the run.
 * A failed upload only warns.
 */
const jobUploads = async (
  client: LaminarClient,
  uploadId: string,
): Promise<JobOutput> => ({
  dir: await mkdtemp(path.join(tmpdir(), "lmnr-jobs-")),
  onDatasetEnd: async (dataset, jobsDir) => {
    const jobDir = await findJobDir(jobsDir);
    if (!jobDir) return;
    try {
      const { archive, index, skipped } = await packJobDir(jobDir);
      if (skipped.length > 0) {
        logger.warn(
          `Not uploading ${skipped.length} large trial file(s) of dataset ` +
            `${dataset}: ${skipped.slice(0, 5).join(", ")}` +
            (skipped.length > 5 ? ", ..." : ""),
        );
      }
      await client.hostedEvals.uploadJob(uploadId, dataset, archive);
      await client.hostedEvals.uploadJobIndex(uploadId, dataset, {
        files: index,
      });
    } catch (error) {
      logger.warn(
        `Could not upload the trial logs of dataset ${dataset}: ` +
          errorMessage(error),
      );
    }
  },
});

/**
 * `lmnr-cli eval orchestrate` (hidden): the remote run's entry point inside
 * its orchestrator sandbox. The evals folder is the cwd; the spec, project key
 * and API URL come from the env the app-server set.
 *
 * Everything the run prints (this CLI's log, Harbor's output) also goes to the
 * run's log in Laminar, which `eval run --remote` follows. Once a line is
 * stored, `$LMNR_RUN_LOG_MARKER` is created: the sandbox's command then sends
 * only the exit code, not its own tail of the output.
 */
export const handleEvalOrchestrate = async (): Promise<void> => {
  const spec = readRunSpec();
  const env = await harborEnv(spec.env, {});
  const client = new LaminarClient({
    baseUrl: env.LMNR_BASE_URL,
    auth: { type: "apiKey", key: env[API_KEY_VAR] },
  });
  const uploadId = process.env.LMNR_EVAL_UPLOAD_ID;
  if (!uploadId) {
    logger.warn(
      "LMNR_EVAL_UPLOAD_ID is not set; the run's log and trial logs won't " +
        "be uploaded.",
    );
    await downloadRunTasks(client, spec.datasets);
    assertDatasetsPassed(
      await runDatasets(
        process.cwd(),
        spec.datasets,
        spec.overrides,
        env,
        spec.images,
      ),
    );
    return;
  }

  const marker = process.env.LMNR_RUN_LOG_MARKER;
  const shipper = createRunLogShipper(
    (lines) => client.hostedEvals.appendRunLogs(uploadId, lines),
    // Sync: a run that fails fast exits right after its first batch.
    marker ? () => writeFileSync(marker, "") : undefined,
  );
  const unsubscribe = onStderr(shipper.writer().write);
  const links = new Set<string>();
  try {
    await downloadRunTasks(client, spec.datasets);
    const failed = await runDatasets(
      process.cwd(),
      spec.datasets,
      spec.overrides,
      // Rich wraps at 80 columns off a terminal, splitting paths and links.
      { ...env, COLUMNS: "500" },
      spec.images,
      {
        jobs: await jobUploads(client, uploadId),
        output: (dataset) => {
          const rewrite = harborLogLine(dataset, links);
          return {
            stdout: shipper.writer(rewrite),
            stderr: shipper.writer(rewrite),
          };
        },
      },
    );
    assertDatasetsPassed(failed);
  } catch (error) {
    // The caller logs it and exits right away, before a flush could run.
    shipper.writer().write(`ERROR: ${errorMessage(error)}\n`);
    throw error;
  } finally {
    unsubscribe();
    await shipper.close();
  }
};
