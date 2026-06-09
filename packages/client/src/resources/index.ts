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
}

export { BaseResource };
