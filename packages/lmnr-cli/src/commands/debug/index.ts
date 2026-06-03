import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";

const logger = initializeLogger();

interface DebugCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

/**
 * Upsert the display name of a debug session. Update-only on the backend: a
 * session id unknown to the project 404s rather than creating a ghost session.
 */
export const handleDebugSessionSetName = async (
  sessionId: string,
  name: string,
  options: DebugCommandOptions,
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    await client.rolloutSessions.setName({ sessionId, name });

    if (options.json) {
      outputJson({ sessionId, name });
      return;
    }

    logger.info(`Set name of session ${sessionId} to "${name}".`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to set session name: ${errorMessage(error)}`);
    process.exit(1);
  }
};
