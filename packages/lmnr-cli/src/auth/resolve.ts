import {
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentialsV2,
  writeCredentials,
} from "./credentials";
import { getConfig, refresh } from "./oidc";

const REFRESH_BUFFER_SECONDS = 30;

export interface AuthInputs {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  /** Explicit profile selector (id or name). Overrides env + active. */
  project?: string;
}

export interface ResolvedAuth {
  /** The string the CLI passes as `projectApiKey` to LaminarClient — JWT or API key. */
  bearer: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Precedence (highest first):
 *   1. --project-api-key flag
 *   2. LMNR_PROJECT_API_KEY env
 *   3. --project <id|name> flag
 *   4. LMNR_PROJECT_ID env (matched against profile projectId / name / prefix)
 *   5. active profile in credentials.json
 *   6. single-profile shortcut
 *   7. error
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
  const refreshed = await refreshIfNeeded(creds, profile);
  return {
    bearer: refreshed.accessToken,
    baseUrl: opts.baseUrl ?? refreshed.baseUrl,
    port: opts.port,
  };
}

function pickProfile(creds: StoredCredentialsV2, explicit?: string): ProfileEntry {
  if (explicit && explicit.length > 0) {
    const match = findProfile(creds, explicit);
    if (!match) {
      throw new Error(
        `No profile matching '${explicit}'. Run \`lmnr-cli list\` to see available profiles.`,
      );
    }
    return match;
  }
  const envProject = process.env.LMNR_PROJECT_ID;
  if (envProject && envProject.length > 0) {
    const match = findProfile(creds, envProject);
    if (!match) {
      throw new Error(
        `LMNR_PROJECT_ID='${envProject}' does not match any stored profile. ` +
          "Run `lmnr-cli list` to see available profiles.",
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
    "Multiple profiles found, specify --project <name|id> or run `lmnr-cli switch <name>`.",
  );
}

/**
 * Refresh the chosen profile's access token if it's within
 * REFRESH_BUFFER_SECONDS of expiry. Always bumps lastUsedAt and persists.
 */
export async function refreshIfNeeded(
  creds: StoredCredentialsV2,
  profile: ProfileEntry,
): Promise<ProfileEntry> {
  const expiresAtMs = new Date(profile.accessTokenExpiresAt).getTime();
  const stillFresh =
    Number.isFinite(expiresAtMs) && expiresAtMs - REFRESH_BUFFER_SECONDS * 1000 > Date.now();

  let updated: ProfileEntry = profile;
  if (!stillFresh) {
    const config = await getConfig(profile.issuer);
    const tokens = await refresh(config, profile.refreshToken);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Refresh did not return access_token + refresh_token");
    }
    const expiresInSec = tokens.expires_in ?? 3600;
    const refreshExpiresIn =
      typeof (tokens as Record<string, unknown>).refresh_token_expires_in === "number"
        ? ((tokens as Record<string, unknown>).refresh_token_expires_in as number)
        : 30 * 24 * 60 * 60;
    updated = {
      ...profile,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      refreshToken: tokens.refresh_token,
      refreshTokenExpiresAt: new Date(Date.now() + refreshExpiresIn * 1000).toISOString(),
      tokenType: tokens.token_type ?? "Bearer",
      scope: tokens.scope ?? profile.scope,
    };
  }

  // Bump lastUsedAt and persist (write is tiny — fine on every call).
  updated = { ...updated, lastUsedAt: new Date().toISOString() };
  creds.profiles[updated.projectId] = updated;
  await writeCredentials(creds);
  return updated;
}
