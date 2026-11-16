import { LaminarClient } from "@lmnr-ai/client";

import { buildLaminarClient } from "../../auth/client";
import { envHttpPort, resolveBaseUrl } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { findEnvKey } from "../../utils/env-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { API_KEY_VAR } from "./env";

const logger = initializeLogger();

/**
 * Eval commands call the API as the logged-in user, or with the project API
 * key when there is no login (CI).
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

/** The project's page `path` in Laminar, when the project is known locally. */
export const projectUrl = async (
  projectId: string | undefined,
  page: string,
): Promise<string | undefined> => {
  const id = projectId || (await readLocalProjectFile())?.projectId;
  if (!id) return undefined;
  const frontend =
    process.env.LMNR_FRONTEND_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_FRONTEND_URL;
  return `${frontend}/project/${id}/${page}`;
};
