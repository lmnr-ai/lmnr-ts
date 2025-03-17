import { isSpanContextValid, trace } from "@opentelemetry/api";

import {
  EvaluationDatapoint,
  GetDatapointsResponse,
  InitEvaluationResponse,
  PipelineRunRequest,
  PipelineRunResponse,
  SemanticSearchResponse,
} from "./types";
import { otelSpanIdToUUID, otelTraceIdToUUID, StringUUID } from "./utils";

export class LaminarClient {
  private static baseUrl: string;
  private static projectApiKey: string;

  public static initialize(projectApiKey: string, baseUrl: string) {
    this.projectApiKey = projectApiKey;
    this.baseUrl = baseUrl;
  }

  public static async runPipeline({
    pipeline,
    inputs,
    env,
    metadata = {},
    currentSpanId,
    currentTraceId,
  }: PipelineRunRequest): Promise<PipelineRunResponse> {
    const currentSpan = trace.getActiveSpan();
    let parentSpanId: string | undefined;
    let traceId: string | undefined;
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      parentSpanId = currentSpanId ?? otelSpanIdToUUID(currentSpan.spanContext().spanId);
      traceId = currentTraceId ?? otelTraceIdToUUID(currentSpan.spanContext().traceId);
    } else {
      parentSpanId = currentSpanId;
      traceId = currentTraceId;
    }
    if (this.projectApiKey === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable',
      );
    }

    const response = await fetch(`${this.baseUrl}/v1/pipeline/run`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        inputs,
        pipeline,
        env,
        metadata,
        parentSpanId,
        traceId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to run pipeline ${pipeline}. Response: ${response.statusText}`);
    }
    try {
      return await response.json() as PipelineRunResponse;
    } catch (error: any) {
      throw new Error(`Failed to parse response from pipeline ${pipeline}. ` +
        `Error: ${error}`);
    }
  }

  public static async semanticSearch({
    query,
    datasetId,
    limit,
    threshold,
  }: {
    query: string,
    datasetId: string,
    limit?: number,
    threshold?: number,
  }): Promise<SemanticSearchResponse> {
    const body = JSON.stringify({
      query,
      datasetId,
      limit,
      threshold,
    });

    const response = await fetch(`${this.baseUrl}/v1/semantic-search`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to perform semantic search. Response: ${response.statusText}`);
    }

    return await response.json() as SemanticSearchResponse;
  }

  public static async initEvaluation({
    groupName,
    name,
  }: {
    groupName?: string,
    name?: string,
  }): Promise<InitEvaluationResponse> {
    const body = JSON.stringify({
      groupName: groupName ?? null,
      name: name ?? null,
    });
    const response = await fetch(`${this.baseUrl}/v1/evals`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to create evaluation ${name}. Response: ${response.statusText}`);
    }

    return await response.json() as InitEvaluationResponse;
  }

  public static async saveEvalDatapoints<D, T, O>(
    evalId: StringUUID,
    datapoints: EvaluationDatapoint<D, T, O>[],
    groupName?: string,
  ): Promise<void> {
    let body = '';
    try {
      const points = datapoints.map((point) => ({
        ...point,
        // only save the first 100 characters of data, target, and executorOutput
        // full output is in the trace.
        data: typeof point.data === 'string'
          ? point.data.slice(0, 100)
          : JSON.stringify(point.data).slice(0, 100),
        target: typeof point.target === 'string'
          ? point.target.slice(0, 100)
          : JSON.stringify(point.target).slice(0, 100),
        executorOutput: point.executorOutput === undefined
          ? undefined
          : (
            typeof point.executorOutput === 'string'
              ? point.executorOutput.slice(0, 100)
              : JSON.stringify(point.executorOutput).slice(0, 100)
          ),
      }));
      body = JSON.stringify({ points, groupName });
    } catch (error: any) {
      throw new Error(`Failed to serialize evaluation data for ${evalId}. Error: ${error}`);
    }
    const response = await fetch(`${this.baseUrl}/v1/evals/${evalId}/datapoints`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to save evaluation datapoints. ` +
        `Response: [${response.status}] ${response.statusText}`);
    }
  }

  public static async getDatapoints<D, T>({
    datasetName,
    offset,
    limit,
  }: {
    datasetName: string,
    offset: number,
    limit: number,
  }): Promise<GetDatapointsResponse<D, T>> {
    const params = new URLSearchParams({
      name: datasetName,
      offset: offset.toString(),
      limit: limit.toString(),
    });
    const response = await fetch(
      `${this.baseUrl}/v1/datasets/datapoints?${params.toString()}`,
      {
        method: 'GET',
        headers: this.getHeaders(),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get datapoints for dataset ${datasetName}. ` +
        `Response: ${response.statusText}`);
    }

    return await response.json() as GetDatapointsResponse<D, T>;
  }

  private static getHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.projectApiKey}`,
    };
  };
}
