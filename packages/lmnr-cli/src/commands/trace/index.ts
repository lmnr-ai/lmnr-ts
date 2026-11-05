import { LaminarClient } from "@lmnr-ai/client";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import { GlobalOpts } from "../../auth/with-client";

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
  client: LaminarClient,
  traceId: string,
  tags: string[],
  opts: GlobalOpts,
): Promise<void> => {
  try {
    const result = await client.tags.tag(traceId, tags);
    if (opts.json) {
      outputJson({ traceId, tags, ...result });
      return;
    }
    logger.info(`Tagged trace ${traceId} with: ${tags.join(", ")}`);
  } catch (error) {
    if (opts.json) outputJsonError(error);
    logger.error(
      `Failed to tag trace: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
