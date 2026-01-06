import { SpanType } from "../../types";
import { otelSpanIdToUUID, otelTraceIdToUUID } from "../../utils";
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
      headers: this.headers(),
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

  public async delete({
    sessionId,
  }: {
    sessionId: string;
  }) {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
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
      headers: this.headers(),
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  public async sendSpanUpdate({
    sessionId,
    span,
  }: {
    sessionId: string;
    span: {
      name: string;
      startTime: string;
      spanId: string;
      traceId: string;
      parentSpanId: string | undefined;
      attributes: Record<string, any>;
      spanType: SpanType;
    };
  }) {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}/update`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        type: "spanStart",
        spanId: otelSpanIdToUUID(span.spanId),
        traceId: otelTraceIdToUUID(span.traceId),
        parentSpanId: span.parentSpanId ? otelSpanIdToUUID(span.parentSpanId) : undefined,
        attributes: span.attributes,
        startTime: span.startTime,
        name: span.name,
        spanType: span.spanType,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
