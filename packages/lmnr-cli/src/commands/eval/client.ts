import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { buildLaminarClient } from "../../auth/client";
import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { laminarKeyRejected, laminarUnreachable } from "../../errors";
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

/**
 * Fail unless Laminar takes the project key of a local run (`env` is the
 * Harbor process env, `harborEnv`): the Laminar plugin creates the
 * evaluation with it, and when it can't, the run still goes ahead and its
 * results go nowhere. One read-only request with the key, to the URL the
 * plugin uses: `GET /v1/datasets`, in the same project-key scope as the
 * plugin's evaluation calls. A plain `fetch`, not `LaminarClient`, whose
 * constructor loads `.env` files into `process.env`, which a local run hands
 * to Harbor and Docker.
 */
export const checkProjectKey = async (
  env: Record<string, string>,
  timeoutMs = KEY_CHECK_TIMEOUT_MS,
): Promise<void> => {
  const baseUrl = env.LMNR_BASE_URL;
  const fix =
    "Check LMNR_BASE_URL / LMNR_HTTP_PORT (or --base-url / --port) and " +
    "that the server is up.";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/datasets`, {
      headers: { Authorization: `Bearer ${env[API_KEY_VAR]}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: unknown } | null)?.cause;
    throw laminarUnreachable(
      ((error as Error | null)?.name === "TimeoutError"
        ? `No answer from Laminar at ${baseUrl} in ${timeoutMs / 1000} s`
        : `Can't reach Laminar at ${baseUrl} (${errorMessage(error)}` +
          `${cause ? `: ${errorMessage(cause)}` : ""})`) +
        `, so the run's results would go nowhere. ${fix}`,
    );
  }
  if (response.ok) return;
  const { status } = response;
  if (status === 401 || status === 403) {
    throw laminarKeyRejected(
      `Laminar at ${baseUrl} rejected ${API_KEY_VAR} (${status}), so the ` +
        "run's results would go nowhere. Use a key of the project the " +
        "results belong to (`lmnr-cli setup` writes one to .env), or point " +
        "LMNR_BASE_URL (or --base-url / --port) at the Laminar it belongs to.",
    );
  }
  const body = await response.text().catch(() => "");
  throw laminarUnreachable(
    `Laminar at ${baseUrl} failed a check of ${API_KEY_VAR} ` +
      `(GET /v1/datasets: ${`${status} ${body}`.trim().slice(0, 200)}), so ` +
      `the run's results would go nowhere. ${fix}`,
  );
};
