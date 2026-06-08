import open from "open";

import { type ProfileEntry, upsertProfile } from "../../auth/credentials";
import {
  CLI_CLIENT_ID,
  CLI_SCOPE,
  decodeJwtExp,
  fetchSession,
  initiateDevice,
  mintAccessJwt,
  pollDevice,
} from "../../auth/device";

const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

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
  const token = await pollDevice(issuer, da.device_code, {
    intervalSeconds: da.interval,
    timeoutSeconds: da.expires_in,
  });

  // The device token's access_token is the durable session token (refresh).
  const sessionToken = token.access_token;
  const jwt = await mintAccessJwt(issuer, sessionToken);
  const session = await fetchSession(issuer, sessionToken);

  const now = new Date().toISOString();
  const profile: ProfileEntry = {
    issuer,
    baseUrl,
    sessionToken,
    accessToken: jwt,
    accessTokenExpiresAt: decodeJwtExp(jwt) ?? now,
    sessionExpiresAt:
      typeof token.expires_in === "number"
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : undefined,
    userEmail: session.email || undefined,
    userId: session.id,
    createdAt: now,
    lastUsedAt: now,
  };
  await upsertProfile(profile);

  process.stderr.write(`Logged in as ${session.email || "<unknown>"}.\n`);
  process.stderr.write(
    `Client: ${CLI_CLIENT_ID}. Tokens stored at ~/.config/lmnr/credentials.json (mode 0600).\n`,
  );
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}
