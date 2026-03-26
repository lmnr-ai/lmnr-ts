import { LaminarClient } from "@lmnr-ai/client";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";

const logger = initializeLogger();

interface TraceCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

/**
 * Handle trace tag add command.
 */
export const handleTraceTagAdd = async (
  traceId: string,
  tags: string[],
  options: TraceCommandOptions,
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    const result = await client.tags.tag(traceId, tags);

    if (options.json) {
      outputJson({ traceId, tags, ...result });
      return;
    }

    logger.info(`Tagged trace ${traceId} with: ${tags.join(", ")}`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(
      `Failed to tag trace: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
