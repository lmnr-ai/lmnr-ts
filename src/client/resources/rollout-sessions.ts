import { BaseResource } from "./index";

interface SessionResponse {
  span: {
    name: string;
    input: string;
    output: string;
    attributes: Record<string, any>;
  };
  pathToCount: Record<string, number>;
}

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  public async get({
    path,
    index,
    sessionId,
  }: {
    path: string;
    index: number;
    sessionId: string;
  }): Promise<SessionResponse | undefined> {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "POST",
      headers: {
        ...this.headers(),
      },
      body: JSON.stringify({
        path,
        index,
      }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return;
      }
      throw new Error(`${response.status} ${await response.text()}`);
    }

    return await response.json() as SessionResponse;
  }

  public async setStatus({
    sessionId,
    status,
  }: {
    sessionId: string;
    status: 'PENDING' | 'RUNNING' | 'FINISHED' | 'STOPPED';
  }) {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}/status`, {
      method: "PATCH",
      headers: {
        ...this.headers(),
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
