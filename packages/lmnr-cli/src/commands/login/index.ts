import open from "open";

import { type Credentials, writeCredentials } from "../../auth/credentials";
import {
  CLI_SCOPE,
  decodeJwtExp,
  fetchSession,
  initiateDevice,
  mintAccessJwt,
  parseProjectFromMetadata,
  pollDevice,
} from "../../auth/device";
import { DEFAULT_DASHBOARD_URL } from "../../constants";
import { pc } from "../../utils/colors";

export interface LoginOptions {
  dashboardUrl?: string;
  baseUrl?: string;
  noBrowser?: boolean;
}

export interface LoginResult {
  /** The signed-in user's id (from the BetterAuth session). */
  userId: string;
  /** The signed-in user's email, when present on the session. */
  userEmail: string | null;
  /**
   * The projectId the user selected/created in the browser, delivered back via
   * the device-token `x-lmnr-metadata` response header (see
   * `parseProjectFromMetadata`). Null on the already-logged-in / legacy paths
   * where the browser had nothing to select.
   */
  projectId: string | null;
}

export async function handleLogin(options: LoginOptions): Promise<LoginResult> {
  const issuer = pick(options.dashboardUrl, process.env.LMNR_DASHBOARD_URL, DEFAULT_DASHBOARD_URL);
  // NOTE: login does NOT resolve/store a data-API baseUrl — the device flow,
  // JWT mint and session fetch all hit `issuer` (dashboard). `--base-url` on
  // login is accepted but inert (candidate for removal); data commands resolve
  // baseUrl themselves via resolveBaseUrl.

  const da = await initiateDevice(issuer, CLI_SCOPE);
  const completeUri = da.verification_uri_complete ?? da.verification_uri;
  process.stderr.write(
    `\nOpen this URL in your browser to authorize:\n  ${pc.cyan(completeUri)}\n`,
  );
  if (da.user_code) {
    process.stderr.write(`Code: ${pc.bold(pc.cyan(da.user_code))}\n\n`);
  }

  if (!options.noBrowser) {
    try {
      await open(completeUri);
    } catch {
      // Best-effort. The user can copy/paste the URL.
    }
  }

  process.stderr.write(pc.dim("Waiting for authorization...\n"));
  const token = await pollDevice(issuer, da.device_code, {
    intervalSeconds: da.interval,
    timeoutSeconds: da.expires_in,
  });

  // The device token's access_token is the durable session token (refresh).
  const sessionToken = token.access_token;
  const jwt = await mintAccessJwt(issuer, sessionToken);
  const session = await fetchSession(issuer, sessionToken);

  const now = new Date().toISOString();
  const creds: Credentials = {
    version: 1,
    issuer,
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
  await writeCredentials(creds);

  // NOTE: the user-facing "logged in / next steps" summary is intentionally NOT
  // printed here — handleLogin is shared with `setup`, which prints its own
  // summary. The `login` command prints the summary itself (see src/index.ts).

  return {
    userId: session.id,
    userEmail: session.email || null,
    projectId: parseProjectFromMetadata(token.metadata),
  };
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}
