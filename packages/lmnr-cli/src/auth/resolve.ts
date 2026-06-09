import { readProjectLink } from "../utils/project-link";
import { type Credentials, readCredentials, writeCredentials } from "./credentials";
import { decodeJwtExp, DeviceFlowError, mintAccessJwt } from "./device";

// Re-mint the JWT when it's within this window of expiry.
const REFRESH_SKEW_MS = 30_000;

export interface AuthInputs {
  /**
   * @deprecated The CLI no longer authenticates via a project API key — it is
   * user-token only. Accepted but IGNORED (kept so legacy call sites compile).
   * Project API keys are an app/SDK concern written to .env by `setup`.
   */
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  /**
   * Target project (directory-scoped). The user JWT is user-scoped, so a
   * project is required. Precedence: this > LMNR_PROJECT_ID > the nearest
   * `.lmnr/project.json` link written by `setup`.
   */
  projectId?: string;
}

export interface ResolvedAuth {
  /** The user-scoped BetterAuth access JWT (refreshed near expiry). */
  bearer: string;
  baseUrl?: string;
  port?: number;
  /**
   * The resolved target project id. Signals the client to route to `/v1/cli/*`
   * with an `x-lmnr-project-id` header.
   */
  cliUserProjectId?: string;
}

/**
 * CLI auth is **user-token only** — the CLI authenticates as the single
 * signed-in user via the stored BetterAuth session (refreshed access JWT),
 * never via a project API key.
 *
 * Project precedence (directory-scoped): `--project-id` flag > LMNR_PROJECT_ID
 * env > the nearest `.lmnr/project.json` (written by `setup`). The project is
 * NOT stored in credentials.json — that holds only user auth.
 */
export async function resolveAuth(opts: AuthInputs): Promise<ResolvedAuth> {
  const creds = await readCredentials();
  if (!creds) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }

  let projectId = opts.projectId ?? process.env.LMNR_PROJECT_ID;
  if (!projectId || projectId.length === 0) {
    projectId = (await readProjectLink())?.projectId;
  }
  if (!projectId || projectId.length === 0) {
    throw new Error(
      "No project for this directory. Run `lmnr-cli setup` here, " +
        "pass --project-id <id>, or set LMNR_PROJECT_ID.",
    );
  }

  const updated = await refreshIfNeeded(creds);
  return {
    bearer: updated.accessToken,
    baseUrl: opts.baseUrl ?? updated.baseUrl,
    port: opts.port,
    cliUserProjectId: projectId,
  };
}

/**
 * Resolve only the user-scoped access token (no project) — for discovery
 * endpoints like listing projects, which run BEFORE a project is selected.
 */
export async function resolveUserToken(opts: {
  baseUrl?: string;
  port?: number;
}): Promise<{ bearer: string; baseUrl?: string; port?: number }> {
  const creds = await readCredentials();
  if (!creds) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }
  const updated = await refreshIfNeeded(creds);
  return {
    bearer: updated.accessToken,
    baseUrl: opts.baseUrl ?? updated.baseUrl,
    port: opts.port,
  };
}

/**
 * Re-mint the access JWT when it's near expiry, persist it, and bump
 * lastUsedAt. A 401 from the token endpoint means the session is gone — surface
 * a clear "run login" error.
 */
export async function refreshIfNeeded(creds: Credentials): Promise<Credentials> {
  const next: Credentials = { ...creds };
  const expMs = new Date(creds.accessTokenExpiresAt).getTime();
  const nearExpiry = !Number.isFinite(expMs) || expMs - Date.now() <= REFRESH_SKEW_MS;
  if (nearExpiry) {
    try {
      const jwt = await mintAccessJwt(creds.issuer, creds.sessionToken);
      next.accessToken = jwt;
      next.accessTokenExpiresAt = decodeJwtExp(jwt) ?? new Date().toISOString();
    } catch (e) {
      if (e instanceof DeviceFlowError && e.code === "invalid_grant") {
        throw new Error("Session expired — run `lmnr-cli login`.");
      }
      throw e;
    }
  }
  next.lastUsedAt = new Date().toISOString();
  await writeCredentials(next);
  return next;
}
