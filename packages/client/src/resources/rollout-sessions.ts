import { BaseResource } from "./index";

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Idempotently register (upsert) a debug session on the backend, keyed on the
   * SDK-supplied session id. The backend stores the row so the session is
   * visible in the UI; a null/omitted name never clobbers a name set elsewhere.
   */
  public async register({
    sessionId,
    name,
  }: {
    sessionId: string;
    name?: string;
  }): Promise<void> {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  public async delete({
    sessionId,
  }: {
    sessionId: string;
  }): Promise<void> {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
