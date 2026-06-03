import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";

const logger = initializeLogger();

// Trace-metadata key the debugger UI reads the agent's note from. Metadata
// naming stays `rollout.*` (matching `rollout.session_id`); the value is an
// opaque string the frontend renders as markdown.
const NOTE_METADATA_KEY = "rollout.note";

interface TraceCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

/**
 * Upsert a free-text note onto an existing trace. Stored under the
 * `rollout.note` trace-metadata key via the post-factum metadata patch endpoint
 * (last-write-wins). The note may contain markdown / span-reference links.
 */
export const handleTraceSetNote = async (
  traceId: string,
  note: string,
  options: TraceCommandOptions,
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    await client.traces.pushMetadata(traceId, { [NOTE_METADATA_KEY]: note });

    if (options.json) {
      outputJson({ traceId, note });
      return;
    }

    logger.info(`Set note on trace ${traceId}.`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to set trace note: ${errorMessage(error)}`);
    process.exit(1);
  }
};
