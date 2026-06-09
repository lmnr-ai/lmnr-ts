// Shared auth-related types for the CLI (device flow + resolved auth).

// --- Device flow (RFC 8628 against BetterAuth) ---

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** BetterAuth device token success — the `access_token` IS the session token. */
export interface DeviceTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  /**
   * Raw `x-lmnr-metadata` response header (a JSON string) forwarded by the
   * server's /device/token before-hook. Carries CLI round-trip metadata such as
   * the browser-selected projectId. Null/absent on legacy or no-selection paths.
   */
  metadata?: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
}

export interface PollOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  onTick?: () => void;
}

// --- Resolved auth (inputs + result) ---

export interface AuthInputs {
  baseUrl?: string;
  port?: number;
  /**
   * Target project (directory-scoped). The user JWT is user-scoped, so a
   * project is required. Precedence: this `--project-id` flag > the nearest
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
  projectId: string;
}
