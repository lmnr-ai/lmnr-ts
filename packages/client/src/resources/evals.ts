import {
  type Evaluation,
  type EvaluationDatapoint,
  type GetDatapointsResponse,
  type InitEvaluationResponse,
  type StringUUID,
} from "@lmnr-ai/types";

import { initializeLogger, newUUID, slicePayload } from "../utils";
import { BaseResource, type LaminarAuth } from ".";

const logger = initializeLogger();
const INITIAL_EVALUATION_DATAPOINT_MAX_DATA_LENGTH = 16_000_000; // 16MB

export class EvalsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Initialize an evaluation.
   *
   * @param {string} name - Name of the evaluation
   * @param {string} groupName - Group name of the evaluation
   * @param {Record<string, any>} metadata - Optional metadata
   * @returns {Promise<InitEvaluationResponse>} Response from the evaluation initialization
   */
  public async init(
    name?: string,
    groupName?: string,
    metadata?: Record<string, any>,
  ): Promise<InitEvaluationResponse> {
    const response = await fetch(this.baseHttpUrl + "/v1/evals", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: name ?? null,
        groupName: groupName ?? null,
        metadata: metadata ?? null,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<InitEvaluationResponse>;
  }

  /**
   * Create a new evaluation and return its ID.
   *
   * @param {string} [name] - Optional name of the evaluation
   * @param {string} [groupName] - An identifier to group evaluations
   * @param {Record<string, any>} [metadata] - Optional metadata
   * @returns {Promise<StringUUID>} The evaluation ID
   */

  public async create(args?: {
    name?: string, groupName?: string, metadata?: Record<string, any>
  }): Promise<StringUUID> {
    const evaluation = await this.init(args?.name, args?.groupName, args?.metadata);
    return evaluation.id;
  }

  /**
   * Update an evaluation's name and/or metadata. The group ID is immutable.
   * Fields left undefined are kept unchanged.
   *
   * @param {Object} options - Update evaluation options
   * @param {string} options.evalId - The evaluation ID
   * @param {string} [options.name] - New name of the evaluation
   * @param {Record<string, any>} [options.metadata] - New metadata for the evaluation
   * @returns {Promise<InitEvaluationResponse>} The updated evaluation
   */
  public async update({
    evalId,
    name,
    metadata,
  }: {
    evalId: string;
    name?: string;
    metadata?: Record<string, any>;
  }): Promise<InitEvaluationResponse> {
    const response = await fetch(this.baseHttpUrl + `/v1/evals/${evalId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: name ?? null,
        metadata: metadata ?? null,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<InitEvaluationResponse>;
  }

  /**
   * List evaluations in the project, newest first.
   *
   * @param {Object} [options] - Filters
   * @param {string} [options.groupId] - Only evaluations in this group
   * @param {string} [options.name] - Case-insensitive substring match on the name
   * @param {string[]} [options.tags] - Only evaluations carrying ALL of these tags
   * @param {number} [options.limit] - Page size (default 50, max 500)
   * @param {number} [options.offset] - Page offset
   * @returns {Promise<Evaluation[]>} The matching evaluations, each with its tags
   */
  public async list(options?: {
    groupId?: string;
    name?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Evaluation[]> {
    const params = new URLSearchParams();
    if (options?.groupId) params.set("groupId", options.groupId);
    if (options?.name) params.set("name", options.name);
    if (options?.tags?.length) params.set("tags", options.tags.join(","));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.offset !== undefined) params.set("offset", String(options.offset));
    const query = params.size > 0 ? `?${params.toString()}` : "";

    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/evals${query}`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.raiseEvalError(response);
    }

    const body = (await response.json()) as { evaluations?: Evaluation[] };
    return Array.isArray(body?.evaluations) ? body.evaluations : [];
  }

  /**
   * Get a single evaluation with its tags.
   *
   * @param {string} evalId - The evaluation ID
   * @returns {Promise<Evaluation>} The evaluation
   */
  public async get(evalId: string): Promise<Evaluation> {
    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/evals/${evalId}`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.raiseEvalError(response);
    }

    return response.json() as Promise<Evaluation>;
  }

  /**
   * Attach tags to an evaluation. Unknown tag names are registered as new tag
   * classes in the project. Already-attached tags are a no-op.
   *
   * @param {string} evalId - The evaluation ID
   * @param {string[]} tags - Tag names to attach
   * @returns {Promise<string[]>} The evaluation's full tag list
   */
  public async addTags(evalId: string, tags: string[]): Promise<string[]> {
    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/evals/${evalId}/tags`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tags }),
    });

    if (!response.ok) {
      await this.raiseEvalError(response);
    }

    const body = (await response.json()) as { tags?: string[] };
    return Array.isArray(body?.tags) ? body.tags : [];
  }

  /**
   * Detach a single tag from an evaluation.
   *
   * @param {string} evalId - The evaluation ID
   * @param {string} tag - Tag name to detach
   * @returns {Promise<string[]>} The evaluation's remaining tag list
   */
  public async removeTag(evalId: string, tag: string): Promise<string[]> {
    const url =
      `${this.baseHttpUrl}${this.apiPrefix}/evals/${evalId}/tags/${encodeURIComponent(tag)}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.raiseEvalError(response);
    }

    const body = (await response.json()) as { tags?: string[] };
    return Array.isArray(body?.tags) ? body.tags : [];
  }

  /** Unwrap `{ error: "<message>" }` envelopes so the CLI shows the message, not raw JSON. */
  private async raiseEvalError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch { /* Not JSON — use it as-is. */ }
    throw new Error(`${response.status} ${message}`);
  }

  /**
   * Create a new evaluation and return its ID.
   * @deprecated use `create` instead.
   */
  public async createEvaluation(
    name?: string,
    groupName?: string,
    metadata?: Record<string, any>,
  ): Promise<StringUUID> {
    const evaluation = await this.init(name, groupName, metadata);
    return evaluation.id;
  }

  /**
   * Create a datapoint for an evaluation.
   *
   * @param {Object} options - Create datapoint options
   * @param {string} options.evalId - The evaluation ID
   * @param {D} options.data - The input data for the executor
   * @param {T} [options.target] - The target/expected output for evaluators
   * @param {Record<string, any>} [options.metadata] - Optional metadata
   * @param {number} [options.index] - Optional index of the datapoint
   * @param {string} [options.traceId] - Optional trace ID
   * @returns {Promise<StringUUID>} The datapoint ID
   */
  public async createDatapoint<D, T>({
    evalId,
    data,
    target,
    metadata,
    index,
    traceId,
  }: {
    evalId: string;
    data: D;
    target?: T;
    metadata?: Record<string, any>;
    index?: number;
    traceId?: string;
  }): Promise<StringUUID> {
    const datapointId = newUUID();

    const partialDatapoint: EvaluationDatapoint<D, T, any> = {
      id: datapointId,
      data,
      target,
      index: index ?? 0,
      traceId: traceId ?? newUUID(),
      executorSpanId: newUUID(),
      metadata,
    };

    await this.saveDatapoints({
      evalId,
      datapoints: [partialDatapoint],
    });

    return datapointId;
  }

  /**
   * Update a datapoint with evaluation results.
   *
   * @param {Object} options - Update datapoint options
   * @param {string} options.evalId - The evaluation ID
   * @param {string} options.datapointId - The datapoint ID
   * @param {Record<string, number>} options.scores - The scores
   * @param {O} [options.executorOutput] - The executor output
   * @returns {Promise<void>}
   */
  public async updateDatapoint<O>({
    evalId,
    datapointId,
    scores,
    executorOutput,
  }: {
    evalId: string;
    datapointId: string;
    scores: Record<string, number>;
    executorOutput?: O;
  }): Promise<void> {
    const response = await fetch(
      this.baseHttpUrl + `/v1/evals/${evalId}/datapoints/${datapointId}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          executorOutput,
          scores,
        }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  /**
   * Save evaluation datapoints.
   *
   * @param {Object} options - Save datapoints options
   * @param {string} options.evalId - ID of the evaluation
   * @param {EvaluationDatapoint<D, T, O>[]} options.datapoints - Datapoint to add
   * @param {string} [options.groupName] - Group name of the evaluation
   * @returns {Promise<void>} Response from the datapoint addition
   */
  public async saveDatapoints<D, T, O>({
    evalId,
    datapoints,
    groupName,
  }: {
    evalId: string;
    datapoints: EvaluationDatapoint<D, T, O>[];
    groupName?: string;
  }): Promise<void> {
    const response = await fetch(this.baseHttpUrl + `/v1/evals/${evalId}/datapoints`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        points: datapoints.map((d) => (
          {
            ...d,
            data: slicePayload(d.data, INITIAL_EVALUATION_DATAPOINT_MAX_DATA_LENGTH),
            target: slicePayload(d.target, INITIAL_EVALUATION_DATAPOINT_MAX_DATA_LENGTH),
            executorOutput: slicePayload(
              d.executorOutput,
              INITIAL_EVALUATION_DATAPOINT_MAX_DATA_LENGTH,
            ),
          })),
        groupName: groupName ?? null,
      }),
    });

    if (response.status === 413) {
      return await this.retrySaveDatapoints({
        evalId,
        datapoints,
        groupName,
      });
    }

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  /**
   * Get evaluation datapoints.
   *
   * @deprecated Use `client.datasets.pull()` instead.
   * @param {Object} options - Get datapoints options
   * @param {string} options.datasetName - Name of the dataset
   * @param {number} options.offset - Offset at which to start the query
   * @param {number} options.limit - Maximum number of datapoints to return
   * @returns {Promise<GetDatapointsResponse>} Response from the datapoint retrieval
   */
  public async getDatapoints<D, T>({
    datasetName,
    offset,
    limit,
  }: {
    datasetName: string;
    offset: number;
    limit: number;
  }): Promise<GetDatapointsResponse<D, T>> {
    logger.warn(
      'evals.getDatapoints() is deprecated. Use client.datasets.pull() instead.',
    );

    const params = new URLSearchParams({
      name: datasetName,
      offset: offset.toString(),
      limit: limit.toString(),
    });
    const response = await fetch(
      this.baseHttpUrl + `/v1/datasets/datapoints?${params.toString()}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    return (await response.json()) as GetDatapointsResponse<D, T>;
  }

  private async retrySaveDatapoints<D, T, O>({
    evalId,
    datapoints,
    groupName,
    maxRetries = 25,
    initialLength = INITIAL_EVALUATION_DATAPOINT_MAX_DATA_LENGTH,
  }: {
    evalId: string;
    datapoints: EvaluationDatapoint<D, T, O>[];
    groupName?: string;
    maxRetries?: number;
    initialLength?: number;
  }): Promise<void> {
    let length = initialLength;
    let lastResponse: Response | null = null;
    for (let i = 0; i < maxRetries; i++) {
      logger.debug(`Retrying save datapoints... ${i + 1} of ${maxRetries}, length: ${length}`);
      const response = await fetch(this.baseHttpUrl + `/v1/evals/${evalId}/datapoints`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          points: datapoints.map((d) => (
            {
              ...d,
              data: slicePayload(d.data, length),
              target: slicePayload(d.target, length),
              executorOutput: slicePayload(d.executorOutput, length),
            })),
          groupName: groupName ?? null,
        }),
      });
      lastResponse = response;
      length = Math.floor(length / 2);
      if (response.status !== 413) {
        break;
      }
    }
    if (lastResponse && !lastResponse.ok) {
      await this.handleError(lastResponse);
    }
  }
}
