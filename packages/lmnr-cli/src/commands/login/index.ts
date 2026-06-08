import { hostname } from "node:os";

import open from "open";

import { type ProfileEntry, upsertProfile } from "../../auth/credentials";
import { CLI_CLIENT_ID, CLI_SCOPE, initiateDevice, pollDevice } from "../../auth/device";

const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";
// API keys don't expire. Park accessTokenExpiresAt far in the future so
// downstream consumers' fresh-token checks never trigger a refresh path.
const NEVER_EXPIRES = "2099-01-01T00:00:00.000Z";

export interface LoginOptions {
  dashboardUrl?: string;
  baseUrl?: string;
  noBrowser?: boolean;
}

export async function handleLogin(options: LoginOptions): Promise<void> {
  const issuer = pick(options.dashboardUrl, process.env.LMNR_DASHBOARD_URL, DEFAULT_DASHBOARD_URL);
  const baseUrl = pick(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);

  const da = await initiateDevice(issuer, CLI_SCOPE);
  const completeUri = da.verification_uri_complete ?? da.verification_uri;
  process.stderr.write(`\nOpen this URL in your browser to authorize:\n  ${completeUri}\n`);
  if (da.user_code) {
    process.stderr.write(`Code: ${da.user_code}\n\n`);
  }

  if (!options.noBrowser) {
    try {
      await open(completeUri);
    } catch {
      // Best-effort. The user can copy/paste the URL.
    }
  }

  process.stderr.write("Waiting for authorization...\n");
  const result = await pollDevice(issuer, da.device_code, {
    intervalSeconds: da.interval,
    timeoutSeconds: da.expires_in,
    deviceName: hostname(),
  });

  const now = new Date().toISOString();
  const profile: ProfileEntry = {
    tokenEndpoint: `${trimSlash(issuer)}/api/cli/device/poll`,
    issuer,
    baseUrl,
    accessToken: result.apiKey,
    accessTokenExpiresAt: NEVER_EXPIRES,
    refreshToken: "",
    refreshTokenExpiresAt: NEVER_EXPIRES,
    tokenType: "Bearer",
    scope: CLI_SCOPE,
    userEmail: result.userEmail ?? undefined,
    userId: result.userId,
    projectId: result.projectId,
    projectName: result.projectName,
    workspaceId: result.workspaceId,
    workspaceName: result.workspaceName,
    apiKeyId: result.apiKeyId,
    createdAt: now,
    lastUsedAt: now,
  };
  await upsertProfile(profile);

  process.stderr.write(
    `Logged in as ${result.userEmail ?? "<unknown>"}. Project: ${result.projectName} (${result.workspaceName}).\n`,
  );
  process.stderr.write(
    `Client: ${CLI_CLIENT_ID}. API key stored at ~/.config/lmnr/credentials.json (mode 0600).\n`,
  );
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
