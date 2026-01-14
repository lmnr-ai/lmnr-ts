import { type RolloutParam, type SpanType } from "@lmnr-ai/types";

import { otelSpanIdToUUID, otelTraceIdToUUID } from "../utils";
import { BaseResource } from "./index";

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Connects to the SSE stream for rollout debugging sessions
   * Returns the Response object for streaming SSE events
   */
  public async connect({
    sessionId,
    name,
    params,
    signal,
  }: {
    sessionId: string;
    params: RolloutParam[];
    name: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "POST",
      headers: {
        ...this.headers(),
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ name, params }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    return response;
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
