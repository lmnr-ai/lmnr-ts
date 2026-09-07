import {
  type LlmProfile,
  type LlmProfileConfig,
  type LlmProfileProvider,
} from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from ".";

/**
 * Plaintext secrets for create/update. On update this is an OVERLAY: an
 * omitted key keeps the stored secret, so credentials never need re-sending.
 */
export interface LlmProfileSecretsInput {
  apiKey?: string;
  secretAccessKey?: string;
  token?: string;
  /** Values for the `custom` provider's `config.headerNames`. */
  headers?: Record<string, string>;
}

export interface CreateLlmProfileOptions {
  name: string;
  provider: LlmProfileProvider;
  /** Omitted `auth` defaults to `{type: "api_key"}`. */
  config?: Partial<LlmProfileConfig>;
  secrets?: LlmProfileSecretsInput;
  models: string[];
}

/**
 * A partial patch: omitted fields keep their stored value. `models` replaces
 * the whole list when present; `config` is required when `provider` changes.
 */
export interface UpdateLlmProfileOptions {
  name?: string;
  provider?: LlmProfileProvider;
  config?: Partial<LlmProfileConfig>;
  secrets?: LlmProfileSecretsInput;
  models?: string[];
}

/**
 * Workspace LLM profile CRUD over the CLI user-token surface
 * (`/v1/cli/llm-profiles`). Validation is entirely server-side; error messages
 * come back user-ready. Self-hosted only: on Laminar Cloud every route 404s
 * with `{error: "LLM profiles are not available on this deployment"}`.
 */
export class LlmProfilesResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Errors come back as `{error: string}` (matches the signals surface) with
   * user-facing text, so unwrap the envelope before raising rather than
   * showing the raw JSON body.
   */
  private async raiseLlmProfileError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON (proxy error page etc.) — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/llm-profiles${path}`,
      {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      await this.raiseLlmProfileError(response);
    }
    return response;
  }

  /**
   * Every workspace LLM profile visible to the caller, ordered
   * case-insensitively by name. Empty array on a workspace with no profiles.
   */
  public async list(): Promise<LlmProfile[]> {
    const response = await this.request("GET", "");
    // Coerce a missing/non-array `llmProfiles` to [] so callers can .map/.length
    // it; a malformed 2xx body is exceptional, not the normal empty case.
    const body = (await response.json()) as { llmProfiles?: LlmProfile[] };
    return Array.isArray(body?.llmProfiles) ? body.llmProfiles : [];
  }

  public async get(profileId: string): Promise<LlmProfile> {
    const response = await this.request("GET", `/${profileId}`);
    return response.json() as Promise<LlmProfile>;
  }

  public async create(options: CreateLlmProfileOptions): Promise<LlmProfile> {
    const response = await this.request("POST", "", options);
    return response.json() as Promise<LlmProfile>;
  }

  public async update(
    profileId: string,
    options: UpdateLlmProfileOptions,
  ): Promise<LlmProfile> {
    const response = await this.request("PATCH", `/${profileId}`, options);
    return response.json() as Promise<LlmProfile>;
  }

  /**
   * Deletes the profile and returns it. The server refuses (409) when any
   * signal still routes through the profile.
   */
  public async delete(profileId: string): Promise<LlmProfile> {
    const response = await this.request("DELETE", `/${profileId}`);
    return response.json() as Promise<LlmProfile>;
  }
}
