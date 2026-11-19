/**
 * Unified auth for every resource. A discriminated union so a single object
 * drives both the URL prefix and the request headers:
 *
 *  - `apiKey`    → project API key (SDK / app surfaces). Routes to `/v1/*`,
 *    Bearer is the project key, no `x-lmnr-project-id` header.
 *  - `userToken` → BetterAuth user access JWT (the CLI user-token surface).
 *    Routes to `/v1/cli/*`, Bearer is the JWT, carries the target project in
 *    the `x-lmnr-project-id` header.
 */
export type LaminarAuth =
  | { type: "apiKey"; key: string }
  | { type: "userToken"; token: string; projectId: string };

/**
 * An API error that carries the server's machine-readable `code` (routes that
 * answer `{"error": "<message>", "code": "<code>"}`), so callers branch on
 * `code` instead of the message text. `body` is the parsed JSON body, if any:
 * some errors carry details (e.g. a 409's list of tasks).
 */
export class LaminarApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(`${status} ${message}`);
    this.name = "LaminarApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

class BaseResource {
  protected readonly baseHttpUrl: string;
  protected readonly auth: LaminarAuth;
  /** The bearer credential, regardless of auth type (project key or user JWT). */
  protected readonly credential: string;

  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    this.baseHttpUrl = baseHttpUrl;
    this.auth = auth;
    this.credential = auth.type === "apiKey" ? auth.key : auth.token;
  }

  /** API path prefix: `/v1/cli` for CLI user-token auth, `/v1` otherwise. */
  protected get apiPrefix(): string {
    return this.auth.type === "userToken" ? "/v1/cli" : "/v1";
  }

  protected headers() {
    return {
      Authorization: `Bearer ${this.credential}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(this.auth.type === "userToken"
        ? { "x-lmnr-project-id": this.auth.projectId }
        : {}),
    };
  }

  protected async handleError(response: Response) {
    const errorMsg = await response.text();
    throw new Error(`${response.status} ${errorMsg}`);
  }

  /**
   * For routes that answer errors as `{error: "<message>"}` with user-facing
   * text: raise that message instead of the raw JSON body, falling back to the
   * body when it isn't that shape (a proxy error page, a plain-text 413).
   */
  protected async handleErrorMessage(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }

  /**
   * For routes that answer errors as `{error, code}`: a {@link LaminarApiError}
   * with the server's message and code (the raw body as the message when it
   * isn't that shape, e.g. a proxy error page).
   */
  protected async apiError(response: Response): Promise<LaminarApiError> {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // No readable body: fall back to the status text.
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new LaminarApiError(response.status, text || response.statusText);
    }
    const { error, code } = (body ?? {}) as { error?: unknown; code?: unknown };
    return new LaminarApiError(
      response.status,
      typeof error === "string" && error ? error : text,
      typeof code === "string" ? code : undefined,
      body,
    );
  }
}

export { BaseResource };
