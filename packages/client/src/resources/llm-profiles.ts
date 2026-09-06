import { type LlmProfileOption } from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from ".";

/**
 * Workspace LLM profile discovery for the CLI. Hits
 * `GET /v1/cli/llm-profiles`, which returns the caller's project's workspace
 * profiles (id + name + provider + models) so `lmnr-cli signal create
 * --llm-profile <name> --model <name>` can be discovered offline.
 *
 * Self-hosted only: on Laminar Cloud the server 404s with
 * `{error: "LLM profiles are not available on Laminar Cloud"}`.
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

  /**
   * Every workspace LLM profile visible to the caller, ordered
   * case-insensitively by name. Empty array on a workspace with no profiles.
   */
  public async list(): Promise<LlmProfileOption[]> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/llm-profiles`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      await this.raiseLlmProfileError(response);
    }
    // Coerce a missing/non-array `llmProfiles` to [] so callers can .map/.length
    // it; a malformed 2xx body is exceptional, not the normal empty case.
    const body = (await response.json()) as {
      llmProfiles?: LlmProfileOption[];
    };
    return Array.isArray(body?.llmProfiles) ? body.llmProfiles : [];
  }
}
