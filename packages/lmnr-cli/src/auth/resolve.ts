import { readCredentials, type StoredCredentials, writeCredentials } from "./credentials";
import { getConfig, refresh } from "./oidc";

const REFRESH_BUFFER_SECONDS = 30;

export interface AuthInputs {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
}

export interface ResolvedAuth {
  /** The string the CLI passes as `projectApiKey` to LaminarClient — JWT or API key. */
  bearer: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Precedence: explicit flag > LMNR_PROJECT_API_KEY env > stored OAuth credentials.
 * If stored credentials are within REFRESH_BUFFER_SECONDS of expiring, refresh
 * before returning.
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

  const refreshed = await refreshIfNeeded(creds);
  return {
    bearer: refreshed.accessToken,
    baseUrl: opts.baseUrl ?? refreshed.baseUrl,
    port: opts.port,
  };
}

export async function refreshIfNeeded(creds: StoredCredentials): Promise<StoredCredentials> {
  const expiresAtMs = new Date(creds.accessTokenExpiresAt).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs - REFRESH_BUFFER_SECONDS * 1000 > Date.now()) {
    return creds;
  }
  // Refresh.
  const config = await getConfig(creds.issuer);
  const tokens = await refresh(config, creds.refreshToken);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Refresh did not return access_token + refresh_token");
  }
  const expiresInSec = tokens.expires_in ?? 3600;
  const refreshExpiresIn =
    typeof (tokens as Record<string, unknown>).refresh_token_expires_in === "number"
      ? ((tokens as Record<string, unknown>).refresh_token_expires_in as number)
      : 30 * 24 * 60 * 60;
  const updated: StoredCredentials = {
    ...creds,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    refreshToken: tokens.refresh_token,
    refreshTokenExpiresAt: new Date(Date.now() + refreshExpiresIn * 1000).toISOString(),
    tokenType: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? creds.scope,
  };
  await writeCredentials(updated);
  return updated;
}
