import {
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
  writeCredentials,
} from "./credentials";
import { decodeJwtExp, DeviceFlowError, mintAccessJwt } from "./device";

// Re-mint the JWT when it's within this window of expiry.
const REFRESH_SKEW_MS = 30_000;

export interface AuthInputs {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  /** Explicit profile selector (userId or email). Overrides env + active. */
  project?: string;
}

export interface ResolvedAuth {
  /** The bearer token — JWT for profile auth, raw key for flag/env auth. */
  bearer: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Precedence (highest first):
 *   1. --project-api-key flag
 *   2. LMNR_PROJECT_API_KEY env
 *   3. --project <userId|email> flag
 *   4. active profile in credentials.json
 *   5. single-profile shortcut
 *   6. error
 *
 * For the profile path, the bearer is the user-scoped access JWT, refreshed via
 * GET /api/auth/token when it's within ~30s of expiry.
 */
export async function resolveAuth(opts: AuthInputs): Promise<ResolvedAuth> {
  if (opts.projectApiKey && opts.projectApiKey.length > 0) {
    return { bearer: opts.projectApiKey, baseUrl: opts.baseUrl, port: opts.port };
  }
  const envKey = process.env.LMNR_PROJECT_API_KEY;
  if (envKey && envKey.length > 0) {
    return { bearer: envKey, baseUrl: opts.baseUrl, port: opts.port };
  }

  const creds = await readCredentials();
  if (!creds) {
    throw new Error(
      "Not authenticated. Run `lmnr-cli login` or pass --project-api-key " +
        "/ set LMNR_PROJECT_API_KEY.",
    );
  }

  const profile = pickProfile(creds, opts.project);
  const updated = await refreshIfNeeded(creds, profile);
  return {
    bearer: updated.accessToken,
    baseUrl: opts.baseUrl ?? updated.baseUrl,
    port: opts.port,
  };
}

function pickProfile(creds: StoredCredentials, explicit?: string): ProfileEntry {
  if (explicit && explicit.length > 0) {
    const match = findProfile(creds, explicit);
    if (!match) {
      throw new Error(
        `No profile matching '${explicit}'. Run \`lmnr-cli list\` to see available profiles.`,
      );
    }
    return match;
  }
  const active = getActiveProfile(creds);
  if (active) return active;
  const all = Object.values(creds.profiles);
  if (all.length === 1) return all[0];
  if (all.length === 0) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }
  throw new Error(
    "Multiple profiles found, specify --project <email|userId> or run `lmnr-cli switch <email>`.",
  );
}

/**
 * Re-mint the access JWT when it's near expiry, persist it, and bump
 * lastUsedAt. A 401 from the token endpoint means the session is gone — surface
 * a clear "run login" error.
 */
export async function refreshIfNeeded(
  creds: StoredCredentials,
  profile: ProfileEntry,
): Promise<ProfileEntry> {
  let next: ProfileEntry = { ...profile };
  const expMs = new Date(profile.accessTokenExpiresAt).getTime();
  const nearExpiry = !Number.isFinite(expMs) || expMs - Date.now() <= REFRESH_SKEW_MS;
  if (nearExpiry) {
    try {
      const jwt = await mintAccessJwt(profile.issuer, profile.sessionToken);
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
  creds.profiles[next.userId] = next;
  await writeCredentials(creds);
  return next;
}
