import type { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";

const logger = initializeLogger();

/**
 * Handle trace tag add command. Pure handler — `withProjectClient` resolves the
 * client and owns the error envelope (JSON error output + exit code).
 */
export const handleTraceTagAdd = async (
  client: LaminarClient,
  traceId: string,
  tags: string[],
  opts: GlobalOpts,
): Promise<void> => {
  const result = await client.tags.tag(traceId, tags);
  if (opts.json) {
    outputJson({ traceId, tags, ...result });
    return;
  }
  logger.info(`Tagged trace ${traceId} with: ${tags.join(", ")}`);
};
