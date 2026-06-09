import { LaminarClient } from "@lmnr-ai/client";

import { type AuthInputs, resolveAuth } from "./resolve";

/**
 * Build a LaminarClient for CLI commands. Auth is user-token only: the bearer
 * is the stored BetterAuth access JWT (auto-refreshed near expiry) and requests
 * route to `/v1/cli/*` with the resolved project in `x-lmnr-project-id`.
 */
export async function buildLaminarClient(opts: AuthInputs): Promise<LaminarClient> {
  const auth = await resolveAuth(opts);
  return new LaminarClient({
    projectApiKey: auth.bearer,
    baseUrl: auth.baseUrl,
    port: auth.port,
    // Set only for user-token (profile) auth → routes to /v1/cli/* with the
    // x-lmnr-project-id header. Undefined for project-API-key auth (/v1/*).
    cliUserProjectId: auth.cliUserProjectId,
  });
}
