// Hand-rolled fetch against BetterAuth's RFC 8628 device-flow endpoints. Login
// is user-scoped: the device token endpoint returns a session token (the
// refresh token); the access token is a short-lived JWT minted separately via
// GET /api/auth/token.

import {
  type DeviceCodeResponse,
  type DeviceTokenResponse,
  type PollOptions,
  type SessionUser,
} from "./types";

export const CLI_CLIENT_ID = "lmnr-cli";
export const CLI_SCOPE = "projects:rw";

const DEVICE_CODE_ENDPOINT = "/api/auth/device/code";
const DEVICE_TOKEN_ENDPOINT = "/api/auth/device/token";
const TOKEN_ENDPOINT = "/api/auth/token";
const SESSION_ENDPOINT = "/api/auth/get-session";

type PollErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_client"
  | "server_error";

export class DeviceFlowError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function initiateDevice(
  issuer: string,
  scope: string = CLI_SCOPE,
): Promise<DeviceCodeResponse> {
  const url = `${trimSlash(issuer)}${DEVICE_CODE_ENDPOINT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLI_CLIENT_ID, scope }),
  });
  if (!res.ok) {
    const body = (await safeJson(res)) ?? {};
    throw new DeviceFlowError(
      typeof body.error === "string" ? body.error : `http_${res.status}`,
      typeof body.error_description === "string"
        ? body.error_description
        : `Device authorization request failed (${res.status})`,
    );
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Poll BetterAuth's native token endpoint until the user approves. Returns the
 * full token response (whose `access_token` is the durable session token).
 */
export async function pollDevice(
  issuer: string,
  deviceCode: string,
  opts: PollOptions = {},
): Promise<DeviceTokenResponse> {
  let intervalSeconds = Math.max(1, opts.intervalSeconds ?? 5);
  const timeoutMs = (opts.timeoutSeconds ?? 900) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (Date.now() > deadline) {
      throw new DeviceFlowError("expired_token", "Timed out waiting for authorization");
    }
    const url = `${trimSlash(issuer)}${DEVICE_TOKEN_ENDPOINT}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLI_CLIENT_ID,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as DeviceTokenResponse;
      if (!body.access_token) {
        throw new DeviceFlowError("server_error", "Device token response missing access_token");
      }
      // The browser-selected project (and any future CLI metadata) rides back on
      // the x-lmnr-metadata response header, NOT the OAuth scope. Attach it so
      // callers can parse it via parseProjectFromMetadata.
      body.metadata = res.headers.get("x-lmnr-metadata");
      return body;
    }
    const body = (await safeJson(res)) ?? {};
    const code = (
      typeof body.error === "string" ? body.error : `http_${res.status}`
    ) as PollErrorCode;
    const description = typeof body.error_description === "string" ? body.error_description : code;
    if (code === "authorization_pending") {
      opts.onTick?.();
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (code === "slow_down") {
      intervalSeconds += 5;
      await sleep(intervalSeconds * 1000);
      continue;
    }
    // access_denied / expired_token / invalid_grant / server_error — terminal.
    throw new DeviceFlowError(code, description);
  }
}

/**
 * Mint a fresh 15m EdDSA JWT from a session token. Throws DeviceFlowError
 * "invalid_grant" on 401 (session expired/revoked).
 */
export async function mintAccessJwt(issuer: string, sessionToken: string): Promise<string> {
  const url = `${trimSlash(issuer)}${TOKEN_ENDPOINT}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (res.status === 401) {
    throw new DeviceFlowError("invalid_grant", "Session expired or revoked");
  }
  if (!res.ok) {
    const body = (await safeJson(res)) ?? {};
    throw new DeviceFlowError(
      typeof body.error === "string" ? body.error : `http_${res.status}`,
      `Failed to mint access token (${res.status})`,
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new DeviceFlowError("server_error", "Token endpoint response missing token");
  }
  return body.token;
}

/** Fetch the BetterAuth session for profile metadata (userId, email). */
export async function fetchSession(issuer: string, sessionToken: string): Promise<SessionUser> {
  const url = `${trimSlash(issuer)}${SESSION_ENDPOINT}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    throw new DeviceFlowError(`http_${res.status}`, `Failed to fetch session (${res.status})`);
  }
  const body = (await res.json()) as { user?: { id?: string; email?: string } } | null;
  const user = body?.user;
  if (!user?.id) {
    throw new DeviceFlowError("server_error", "Session response missing user");
  }
  return { id: user.id, email: user.email ?? "" };
}

/**
 * Decode a JWT's `exp` (seconds since epoch) → ISO string. No signature
 * verification — the CLI trusts a token it just received over TLS. Returns null
 * when the token is malformed or carries no numeric `exp`.
 */
export function decodeJwtExp(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_SCOPE_PREFIX = "lmnr_project=";

/**
 * Extract the browser-selected projectId smuggled in the device-token `scope`.
 *
 * NOTE: `lmnr_project=<uuid>` is NOT an OAuth permission scope. The `/device`
 * page writes it into the deviceCode `scope` column (alongside the real
 * `projects:rw`) because the token-poll response echoes `scope` verbatim — it
 * is the only field that round-trips browser → CLI. Parsing is order-tolerant:
 * split on whitespace, find the `lmnr_project=` token, validate the suffix is a
 * UUID. Returns null when absent (legacy / logged-in-elsewhere) or malformed.
 */
export function parseProjectFromScope(scope?: string | null): string | null {
  if (!scope) return null;
  for (const token of scope.split(/\s+/)) {
    if (token.startsWith(PROJECT_SCOPE_PREFIX)) {
      const candidate = token.slice(PROJECT_SCOPE_PREFIX.length);
      if (UUID_RE.test(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Extract the browser-selected projectId from the device-token `x-lmnr-metadata`
 * response header — a JSON string, e.g. `{"projectId":"<uuid>"}`, forwarded by
 * the server's /device/token before-hook. This replaces the old scope-smuggling
 * channel (parseProjectFromScope). Returns null when absent or malformed.
 */
export function parseProjectFromMetadata(metadata?: string | null): string | null {
  if (!metadata) return null;
  try {
    const obj = JSON.parse(metadata) as { projectId?: unknown };
    const pid = obj?.projectId;
    return typeof pid === "string" && UUID_RE.test(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
