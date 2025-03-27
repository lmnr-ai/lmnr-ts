import { trace } from "@opentelemetry/api";

import { PipelineRunRequest, PipelineRunResponse } from "../../types";
import { otelSpanIdToUUID, otelTraceIdToUUID, StringUUID } from "../../utils";
import { BaseResource } from "./index";

export class PipelineResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Run a pipeline with the given inputs and environment variables.
   *
   * @param {Object} options - Pipeline run options
   * @param {string} options.pipeline - Pipeline name
   * @param {Record<string, NodeInput>} options.inputs - Input values for the pipeline
   * @param {Record<string, string>} [options.env] - Environment variables for the pipeline run
   * @param {Record<string, string>} [options.metadata] - Metadata for the pipeline run
   * @param {StringUUID} [options.currentSpanId] - Parent span id for the resulting trace
   * @param {StringUUID} [options.currentTraceId] - Trace id for the resulting trace
   *
   * @throws {Error} If the project API key is not set
   * @throws {Error} If the pipeline run fails
   *
   * @returns {Promise<PipelineRunResponse>} Response from the pipeline run
   */
  public async run({
    pipeline,
    inputs,
    env,
    metadata,
    currentSpanId,
    currentTraceId,
  }: PipelineRunRequest): Promise<PipelineRunResponse> {
    if (this.projectApiKey === "") {
      throw new Error("Project API key is not set");
    }

    const currentSpan = trace.getActiveSpan();
    if (currentSpan && currentSpan.isRecording()) {
      currentTraceId = currentTraceId
        ?? (otelTraceIdToUUID(currentSpan.spanContext().traceId) as StringUUID);
      currentSpanId = currentSpanId
        ?? (otelSpanIdToUUID(currentSpan.spanContext().spanId) as StringUUID);
    }

    const response = await fetch(this.baseHttpUrl + "/v1/pipeline/run", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        pipeline,
        inputs,
        env: env ?? {},
        metadata,
        currentSpanId,
        currentTraceId,
      } as PipelineRunRequest),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<PipelineRunResponse>;
  }
}

