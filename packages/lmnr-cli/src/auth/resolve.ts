import { readProjectLink } from "../utils/project-link";
import { type Credentials, readCredentials, writeCredentials } from "./credentials";
import { decodeJwtExp, DeviceFlowError, mintAccessJwt } from "./device";
import { type AuthInputs, type ResolvedAuth } from "./types";

// Re-mint the JWT when it's within this window of expiry.
const REFRESH_SKEW_MS = 30_000;

/**
 * CLI auth is **user-token only** — the CLI authenticates as the single
 * signed-in user via the stored BetterAuth session (refreshed access JWT),
 * never via a project API key.
 *
 * Project precedence (directory-scoped): `--project-id` flag > the nearest
 * `.lmnr/project.json` (written by `setup`). The project is NOT stored in
 * credentials.json — that holds only user auth.
 */
export async function resolveAuth(opts: AuthInputs): Promise<ResolvedAuth> {
  const creds = await readCredentials();
  if (!creds) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }

  let projectId = opts.projectId;
  if (!projectId || projectId.length === 0) {
    projectId = (await readProjectLink())?.projectId;
  }
  if (!projectId || projectId.length === 0) {
    throw new Error(
      "No project for this directory. Run `lmnr-cli setup` here, " +
        "or pass --project-id <id>.",
    );
  }

  const updated = await refreshIfNeeded(creds);
  return {
    bearer: updated.accessToken,
    baseUrl: opts.baseUrl ?? updated.baseUrl,
    port: opts.port,
    projectId,
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
 * Re-mint the access JWT when it's near expiry and persist it. A 401 from the
 * token endpoint means the session is gone — surface a clear "run login" error.
 *
 * Logout race guard: we write credentials ONLY when we actually re-minted. The
 * old code unconditionally rewrote the file (just to bump lastUsedAt) on every
 * command, so a concurrent `logout` that deleted the file mid-flight could have
 * its delete clobbered by this in-flight atomic rename — logout would appear to
 * succeed while tokens remained on disk. For a fresh (not-near-expiry) token we
 * now do no write at all, eliminating that window for the common case.
 */
export async function refreshIfNeeded(creds: Credentials): Promise<Credentials> {
  const expMs = new Date(creds.accessTokenExpiresAt).getTime();
  const nearExpiry = !Number.isFinite(expMs) || expMs - Date.now() <= REFRESH_SKEW_MS;
  if (!nearExpiry) {
    return creds;
  }

  const next: Credentials = { ...creds };
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
  next.lastUsedAt = new Date().toISOString();
  await writeCredentials(next);
  return next;
}
