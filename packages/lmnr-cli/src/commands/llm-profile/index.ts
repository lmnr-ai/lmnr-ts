import type { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

/**
 * `lmnr-cli llm-profile list` — dumps the caller's project's workspace LLM
 * profiles with the models they declare, ordered case-insensitively by name.
 * The point is to feed `signal create --llm-profile <name> --model <name>`
 * without having to click through the UI.
 *
 * Self-hosted only: on Laminar Cloud the server 404s with
 * `LLM profiles are not available on Laminar Cloud`, surfaced verbatim via the
 * client's error-envelope unwrapping.
 */
export const handleLlmProfileList = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  const profiles = await client.llmProfiles.list();

  if (opts.json) {
    outputJson(profiles);
    return;
  }
  if (profiles.length === 0) {
    logger.info(
      "No LLM profiles in this workspace. Create one in Settings → LLM profiles.",
    );
    return;
  }

  const rows = profiles.map((p) => [
    p.name,
    p.provider,
    p.models.length === 0 ? "-" : p.models.join(", "),
  ]);
  logger.info(renderTable(["Name", "Provider", "Models"], rows));
};
