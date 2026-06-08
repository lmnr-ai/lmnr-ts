import { LaminarClient } from "@lmnr-ai/client";

import { type AuthInputs, resolveAuth } from "./resolve";

/**
 * Build a LaminarClient from CLI options, honouring the auth precedence:
 *   --project-api-key > LMNR_PROJECT_API_KEY > stored OAuth credentials.
 * Stored credentials are auto-refreshed when within 30s of expiry.
 */
export async function buildLaminarClient(opts: AuthInputs): Promise<LaminarClient> {
  const auth = await resolveAuth(opts);
  return new LaminarClient({
    projectApiKey: auth.bearer,
    baseUrl: auth.baseUrl,
    port: auth.port,
  });
}
