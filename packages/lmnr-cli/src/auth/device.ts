// Hand-rolled fetch against BetterAuth's RFC 8628 device-flow endpoints plus
// our own custom poll endpoint (the frontend mints a Laminar project API key
// directly — see lmnr/frontend/app/api/cli/device/poll/route.ts for the why).

export const CLI_CLIENT_ID = "lmnr-cli";
export const CLI_SCOPE = "projects:rw";

const DEVICE_CODE_ENDPOINT = "/api/auth/device/code";
const DEVICE_POLL_ENDPOINT = "/api/cli/device/poll";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface PollSuccess {
  apiKey: string;
  apiKeyId: string;
  apiKeyName: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userEmail: string | null;
}

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

export async function initiateDevice(issuer: string, scope: string = CLI_SCOPE): Promise<DeviceCodeResponse> {
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
        : `Device authorization request failed (${res.status})`
    );
  }
  return (await res.json()) as DeviceCodeResponse;
}

export interface PollOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  deviceName?: string;
  onTick?: () => void;
}

export async function pollDevice(
  issuer: string,
  deviceCode: string,
  opts: PollOptions = {}
): Promise<PollSuccess> {
  let intervalSeconds = Math.max(1, opts.intervalSeconds ?? 5);
  const timeoutMs = (opts.timeoutSeconds ?? 900) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (Date.now() > deadline) {
      throw new DeviceFlowError("expired_token", "Timed out waiting for authorization");
    }
    const url = `${trimSlash(issuer)}${DEVICE_POLL_ENDPOINT}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLI_CLIENT_ID,
        device_name: opts.deviceName,
      }),
    });
    if (res.ok) {
      return (await res.json()) as PollSuccess;
    }
    const body = (await safeJson(res)) ?? {};
    const code = (typeof body.error === "string" ? body.error : `http_${res.status}`) as PollErrorCode;
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
