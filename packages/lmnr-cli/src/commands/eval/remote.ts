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
import {
  hashLocalTasks,
  STATE_FILE,
  type TaskHashes,
  taskFilter,
} from "./dataset-state";
import {
  apiErrorCode,
  datasetApiError,
  forEachLimit,
  installTaskVersion,
  TRANSFER_CONCURRENCY,
} from "./dataset-sync";
import {
  discoverDatasetFolders,
  globToRegExp,
  isValidDatasetName,
  type RunOverrides,
  TASKS_DIR,
} from "./datasets";
import { imagePusher } from "./docker";
import { API_KEY_VAR, harborEnv } from "./env";
import { assertDatasetsPassed, type JobOutput, runDatasets } from "./harbor";
import { ensureRemoteImages, type RemoteImages } from "./images";
import { findJobDir, packJobDir } from "./jobs";
import { packEvalsDir } from "./pack";
import { createRunLogShipper } from "./run-log";
import { harborLogLine } from "./run-log-lines";

const logger = initializeLogger();

/** The server's cap on the uploaded archive (`MAX_ARCHIVE_BYTES`). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/**
 * A remote run, written here and read back by `eval orchestrate` in the
 * orchestrator sandbox, which runs this same CLI version.
 */
interface RunSpec extends RemoteImages, RemoteTasks {
  datasets: string[];
  overrides: RunOverrides;
  /** Values for the datasets' `${VAR}` placeholders and `--env` flags. */
  env: Record<string, string>;
}

/** How a remote run gets its tasks. */
export interface RemoteTasks {
  /**
   * By dataset, task → version: the run's tasks Laminar has, which aren't
   * uploaded with the folder; the orchestrator downloads them into
   * `<dataset>/tasks/<task>` first.
   */
  downloads: Record<string, TaskHashes>;
  /** By dataset (valid names only): every run task's hash, for the plugin. */
  taskHashes: Record<string, TaskHashes>;
}

/**
 * Hash the run's tasks (each dataset's task dirs `--task` selects) and ask
 * Laminar which versions it has: those are downloaded by the orchestrator
 * instead of uploaded. Datasets whose folder name Laminar wouldn't take are
 * uploaded whole.
 */
export const remoteTaskVersions = async (
  client: LaminarClient,
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
): Promise<RemoteTasks> => {
  const selected = taskFilter((overrides.tasks ?? []).map(globToRegExp));
  const tasks: RemoteTasks = { downloads: {}, taskHashes: {} };
  for (const dataset of datasets) {
    if (!isValidDatasetName(dataset)) continue;
    const hashes = await hashLocalTasks(path.join(evalsDir, dataset), selected);
    tasks.taskHashes[dataset] = hashes;
    const versions = Object.entries(hashes).map(([task, hash]) => ({
      task,
      hash,
    }));
    if (versions.length === 0) continue;
    let missing: { task: string; hash: string }[];
    try {
      missing = await client.evalDatasets.missingVersions(dataset, versions);
    } catch (error) {
      if (apiErrorCode(error) !== "storage_not_configured") {
        throw datasetApiError(error);
      }
      logger.warn(
        "This Laminar deployment has no storage for eval datasets; " +
          `uploading every task of ${dataset} with the run.`,
      );
      missing = versions;
    }
    const upload = new Set(missing.map((m) => `${m.task}\0${m.hash}`));
    tasks.downloads[dataset] = Object.fromEntries(
      versions
        .filter((v) => !upload.has(`${v.task}\0${v.hash}`))
        .map((v) => [v.task, v.hash]),
    );
  }
  return tasks;
};

/**
 * What a remote run's upload leaves out (`packEvalsDir`'s `exclude`): dataset
 * folders the run doesn't include, and in the run's datasets the task dirs
 * `--task` doesn't select or the orchestrator downloads, plus the sync state.
 */
export const remoteExclude = (
  datasetFolders: string[],
  datasets: string[],
  overrides: RunOverrides,
  downloads: RemoteTasks["downloads"],
): ((target: string) => boolean) => {
  const run = new Set(datasets);
  const others = new Set(datasetFolders.filter((f) => !run.has(f)));
  const selected = taskFilter((overrides.tasks ?? []).map(globToRegExp));
  return (target) => {
    const [top, sub, name, ...rest] = target.split("/");
    if (others.has(top)) return true;
    if (!run.has(top) || sub !== TASKS_DIR || name === undefined) return false;
    if (rest.length > 0) return false;
    return (
      name === STATE_FILE ||
      !selected(name) ||
      downloads[top]?.[name] !== undefined
    );
  };
};

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Pack and upload the evals folder, push its images, and start the run in an
 * orchestrator sandbox. Returns once that sandbox has started.
 */
export const startRemoteRun = async (
  client: LaminarClient,
  evalsDir: string,
  datasets: string[],
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

  // Tasks Laminar has are downloaded by the run, not uploaded.
  const tasks = await remoteTaskVersions(client, evalsDir, datasets, overrides);
  const downloaded = Object.values(tasks.downloads).reduce(
    (n, d) => n + Object.keys(d).length,
    0,
  );
  // Pack first: a too-large folder fails before minutes of image pushes.
  const { archive, index, fileCount, skippedSymlinks } = await packEvalsDir(
    evalsDir,
    process.platform,
    remoteExclude(
      await discoverDatasetFolders(evalsDir),
      datasets,
      overrides,
      tasks.downloads,
    ),
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
        `${formatMiB(MAX_ARCHIVE_BYTES)} limit. Remove large files (data, ` +
        "build output) from the folder, or push the datasets' tasks " +
        "(`lmnr-cli eval dataset push`) so the run downloads them.",
    );
  }

  const images = await ensureRemoteImages(
    evalsDir,
    datasets,
    overrides,
    imagePusher(client),
  );
  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `datasets: ${datasets.join(", ")}` +
      (downloaded > 0
        ? `; ${downloaded} task(s) already in Laminar are downloaded by the run`
        : ""),
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
  const spec: RunSpec = {
    datasets,
    overrides,
    env: runEnv,
    ...images,
    ...tasks,
  };
  const { sandboxId } = await client.hostedEvals.startRun({
    uploadId,
    cliVersion: version,
    spec,
  });
  return { uploadId, sandboxId };
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

/** Download the run's tasks Laminar has into `<dataset>/tasks/<task>`. */
const downloadTasks = async (
  client: LaminarClient,
  evalsDir: string,
  downloads: RunSpec["downloads"] = {},
) => {
  for (const [dataset, tasks] of Object.entries(downloads)) {
    const versions = Object.entries(tasks).map(([task, hash]) => ({
      task,
      hash,
    }));
    if (versions.length === 0) continue;
    logger.info(`Downloading ${versions.length} task(s) of ${dataset}`);
    await forEachLimit(versions, TRANSFER_CONCURRENCY, (v) =>
      installTaskVersion(client, path.join(evalsDir, dataset), dataset, v),
    );
  }
};

/**
 * Each dataset's Harbor job goes to Laminar once the dataset ends, for the
 * trial log view: the sandbox, and the job dir with it, is deleted after the
 * run. A failed upload only warns.
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
      // The wire still calls it a suite (`?suite=`).
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
 * and API URL come from the env the app-server set. The run's tasks Laminar
 * has are downloaded first (run key, `/v1` routes).
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
  const cwd = process.cwd();
  const uploadId = process.env.LMNR_EVAL_UPLOAD_ID;
  if (!uploadId) {
    logger.warn(
      "LMNR_EVAL_UPLOAD_ID is not set; the run's log and trial logs won't " +
        "be uploaded.",
    );
    await downloadTasks(client, cwd, spec.downloads);
    assertDatasetsPassed(
      await runDatasets(cwd, spec.datasets, spec.overrides, env, spec, {
        taskHashes: spec.taskHashes,
      }),
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
    await downloadTasks(client, cwd, spec.downloads);
    const failed = await runDatasets(
      cwd,
      spec.datasets,
      spec.overrides,
      // Rich wraps at 80 columns off a terminal, splitting paths and links.
      { ...env, COLUMNS: "500" },
      spec,
      {
        jobs: await jobUploads(client, uploadId),
        output: (dataset) => {
          const rewrite = harborLogLine(dataset, links);
          return {
            stdout: shipper.writer(rewrite),
            stderr: shipper.writer(rewrite),
          };
        },
        taskHashes: spec.taskHashes,
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
