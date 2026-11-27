import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { buildLaminarClient } from "../../auth/client";
import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { CliError, laminarKeyRejected, laminarUnreachable } from "../../errors";
import { findEnvKey } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import { API_KEY_VAR } from "./env";

const logger = initializeLogger();

/**
 * The API client of `eval run --remote` and `eval dataset pull / push`: the
 * logged-in user, or the project API key when there is no login (CI).
 */
export const buildEvalClient = async (
  opts: GlobalOpts,
): Promise<LaminarClient> => {
  try {
    return await buildLaminarClient({
      projectId: opts.projectId,
      baseUrl: opts.baseUrl,
      port: opts.port,
    });
  } catch (error) {
    const key = await findEnvKey(process.cwd(), API_KEY_VAR);
    if (!key) throw error;
    logger.debug("No CLI login; using LMNR_PROJECT_API_KEY");
    return new LaminarClient({
      baseUrl: resolveBaseUrl(opts.baseUrl),
      port: opts.port ?? envHttpPort(),
      auth: { type: "apiKey", key: key.value },
    });
  }
};

/** How long the key check waits for Laminar. */
const KEY_CHECK_TIMEOUT_MS = 30_000;

/** The HTTP status of a failed client call (`<status> <body>` or `.status`). */
const httpStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const match = /^(\d{3}) /.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
};

/** A network error with its cause (`fetch failed: connect ECONNREFUSED ...`). */
const networkReason = (error: unknown): string => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause
    ? `${errorMessage(error)}: ${errorMessage(cause)}`
    : errorMessage(error);
};

/**
 * Fail unless Laminar takes the project key of a local run (`env` is the
 * Harbor process env, `harborEnv`): the Laminar plugin creates the
 * evaluation with it, and when it can't, the run still goes ahead and its
 * results go nowhere. One read-only call with the key, against the same URL
 * the plugin uses: `GET /v1/datasets` (`datasets.listDatasets`), in the same
 * project-key scope as the plugin's evaluation calls.
 */
export const checkProjectKey = async (
  env: Record<string, string>,
  timeoutMs = KEY_CHECK_TIMEOUT_MS,
): Promise<void> => {
  const baseUrl = env.LMNR_BASE_URL;
  const client = new LaminarClient({
    baseUrl,
    auth: { type: "apiKey", key: env[API_KEY_VAR] },
  });
  const fix =
    "Check LMNR_BASE_URL / LMNR_HTTP_PORT (or --base-url / --port) and " +
    "that the server is up.";
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          laminarUnreachable(
            `No answer from Laminar at ${baseUrl} in ${timeoutMs / 1000} s, ` +
              `so the run's results would go nowhere. ${fix}`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.datasets.listDatasets(), timeout]);
  } catch (error) {
    if (error instanceof CliError) throw error; // the timeout
    const status = httpStatus(error);
    if (status === 401 || status === 403) {
      throw laminarKeyRejected(
        `Laminar at ${baseUrl} rejected ${API_KEY_VAR} (${status}), so the ` +
          "run's results would go nowhere. Use a key of the project the " +
          "results belong to (`lmnr-cli setup` writes one to .env), or point " +
          "LMNR_BASE_URL (or --base-url / --port) at the Laminar it belongs to.",
      );
    }
    throw laminarUnreachable(
      (status === undefined
        ? `Can't reach Laminar at ${baseUrl} (${networkReason(error)})`
        : `Laminar at ${baseUrl} failed a check of ${API_KEY_VAR} ` +
          `(GET /v1/datasets: ${errorMessage(error).slice(0, 200)})`) +
        `, so the run's results would go nowhere. ${fix}`,
    );
  } finally {
    clearTimeout(timer);
  }
};
