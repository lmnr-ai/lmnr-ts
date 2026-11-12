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
import { imagePusher } from "./docker";
import { API_KEY_VAR, harborEnv } from "./env";
import { assertSuitesPassed, type JobOutput, runSuites } from "./harbor";
import { ensureRemoteImages, type RemoteImages } from "./images";
import { findJobDir, packJobDir } from "./jobs";
import { packEvalsDir } from "./pack";
import { createRunLogShipper } from "./run-log";
import type { RunOverrides } from "./suites";

const logger = initializeLogger();

/** The server's cap on the uploaded archive (`MAX_ARCHIVE_BYTES`). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/**
 * A remote run, written here and read back by `eval orchestrate` in the
 * orchestrator sandbox, which runs this same CLI version.
 */
interface RunSpec extends RemoteImages {
  suites: string[];
  overrides: RunOverrides;
  /** Values for the suites' `${VAR}` placeholders and `--env` flags. */
  env: Record<string, string>;
}

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Pack and upload the evals folder, push its images, and start the run in an
 * orchestrator sandbox. Returns once that sandbox has started.
 */
export const startRemoteRun = async (
  client: LaminarClient,
  evalsDir: string,
  suites: string[],
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

  // Pack first: a too-large folder fails before minutes of image pushes.
  const { archive, index, fileCount, skippedSymlinks } =
    await packEvalsDir(evalsDir);
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
    suites,
    overrides,
    imagePusher(client),
  );
  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `suites: ${suites.join(", ")}`,
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
  const spec: RunSpec = { suites, overrides, env: runEnv, ...images };
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
  if (!Array.isArray(spec?.suites)) {
    throw missingEnv("LMNR_EVAL_RUN is not a run spec: it has no suites.");
  }
  return spec as RunSpec;
};

/**
 * Each suite's Harbor job goes to Laminar once the suite ends, for the trial
 * log view: the sandbox, and the job dir with it, is deleted after the run.
 * A failed upload only warns.
 */
const jobUploads = async (
  client: LaminarClient,
  uploadId: string,
): Promise<JobOutput> => ({
  dir: await mkdtemp(path.join(tmpdir(), "lmnr-jobs-")),
  onSuiteEnd: async (suite, jobsDir) => {
    const jobDir = await findJobDir(jobsDir);
    if (!jobDir) return;
    try {
      const { archive, index, skipped } = await packJobDir(jobDir);
      if (skipped.length > 0) {
        logger.warn(
          `Not uploading ${skipped.length} large trial file(s) of suite ` +
            `${suite}: ${skipped.slice(0, 5).join(", ")}` +
            (skipped.length > 5 ? ", ..." : ""),
        );
      }
      await client.hostedEvals.uploadJob(uploadId, suite, archive);
      await client.hostedEvals.uploadJobIndex(uploadId, suite, {
        files: index,
      });
    } catch (error) {
      logger.warn(
        `Could not upload the trial logs of suite ${suite}: ` +
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
  const uploadId = process.env.LMNR_EVAL_UPLOAD_ID;
  if (!uploadId) {
    logger.warn(
      "LMNR_EVAL_UPLOAD_ID is not set; the run's log and trial logs won't " +
        "be uploaded.",
    );
    assertSuitesPassed(
      await runSuites(process.cwd(), spec.suites, spec.overrides, env, spec),
    );
    return;
  }

  const client = new LaminarClient({
    baseUrl: env.LMNR_BASE_URL,
    auth: { type: "apiKey", key: env[API_KEY_VAR] },
  });
  const marker = process.env.LMNR_RUN_LOG_MARKER;
  const shipper = createRunLogShipper(
    (lines) => client.hostedEvals.appendRunLogs(uploadId, lines),
    // Sync: a run that fails fast exits right after its first batch.
    marker ? () => writeFileSync(marker, "") : undefined,
  );
  const unsubscribe = onStderr(shipper.writer());
  const harbor = { stdout: shipper.writer(), stderr: shipper.writer() };
  try {
    const failed = await runSuites(
      process.cwd(),
      spec.suites,
      spec.overrides,
      env,
      spec,
      {
        jobs: await jobUploads(client, uploadId),
        onOutput: (chunk, stream) => harbor[stream](chunk),
      },
    );
    assertSuitesPassed(failed);
  } catch (error) {
    // The caller logs it and exits right away, before a flush could run.
    shipper.writer()(`ERROR: ${errorMessage(error)}\n`);
    throw error;
  } finally {
    unsubscribe();
    await shipper.close();
  }
};
