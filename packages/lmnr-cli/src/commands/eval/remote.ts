import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { version } from "../../../package.json";
import { archiveTooLarge, missingEnv } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { imagePusher } from "./docker";
import { harborEnv } from "./env";
import { assertSuitesPassed, runSuites } from "./harbor";
import { ensureRemoteImages, type RemoteImages } from "./images";
import { packEvalsDir } from "./pack";
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
  const { archive, fileCount, skippedSymlinks } = await packEvalsDir(evalsDir);
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
    imagePusher(client),
  );
  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `suites: ${suites.join(", ")}`,
  );
  const { uploadId } = await client.hostedEvals.upload(archive);
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
 * `lmnr-cli eval orchestrate` (hidden): the remote run's entry point inside
 * its orchestrator sandbox. The evals folder is the cwd; the spec, project key
 * and API URL come from the env the app-server set.
 */
export const handleEvalOrchestrate = async (): Promise<void> => {
  const spec = readRunSpec();
  const failed = await runSuites(
    process.cwd(),
    spec.suites,
    spec.overrides,
    await harborEnv(spec.env, {}),
    spec,
  );
  assertSuitesPassed(failed);
};
