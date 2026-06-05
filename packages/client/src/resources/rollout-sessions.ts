import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";
import { BaseResource } from "./index";

const logger = initializeLogger();

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Idempotently register (upsert) a debug session on the backend, keyed on the
   * SDK-supplied session id. The backend stores the row so the session is
   * visible in the UI; a null/omitted name never clobbers a name set elsewhere.
   *
   * Returns the backend-resolved `projectId` (derived from the API key) so the
   * caller can build the debugger URL; null if the body can't be parsed.
   */
  public async register({
    sessionId,
    name,
  }: {
    sessionId: string;
    name?: string;
  }): Promise<string | null> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    try {
      const body = (await response.json()) as { projectId?: string };
      return body.projectId ?? null;
    } catch (e) {
      logger.warn(
        `Failed to parse rollout register response: ${errorMessage(e)}`,
      );
      return null;
    }
  }

  /**
   * Rename an existing debug session. Update-only: the backend returns 404 (and
   * this throws) when the session id is unknown for the project, so a mistyped
   * id surfaces as an error rather than silently creating a session. Creation
   * stays the SDK's job via {@link register}.
   */
  public async setName({
    sessionId,
    name,
  }: {
    sessionId: string;
    name: string;
  }): Promise<void> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}/name`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  public async delete({ sessionId }: { sessionId: string }): Promise<void> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
