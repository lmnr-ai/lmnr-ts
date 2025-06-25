import { EvaluationDatapoint, GetDatapointsResponse, InitEvaluationResponse } from "../../types";
import { newUUID, slicePayload, StringUUID } from "../../utils";
import { BaseResource } from ".";

export class EvalsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Initialize an evaluation.
   *
   * @param {string} name - Name of the evaluation
   * @param {string} groupName - Group name of the evaluation
   * @param {Record<string, any>} metadata - Optional metadata
   * @returns {Promise<InitEvaluationResponse>} Response from the evaluation initialization
   */
  public async init(name?: string, groupName?: string, metadata?: Record<string, any>): Promise<InitEvaluationResponse> {
    const response = await fetch(this.baseHttpUrl + "/v1/evals", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: name ?? null, groupName: groupName ?? null, metadata: metadata ?? null }),
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
  public async createEvaluation(name?: string, groupName?: string, metadata?: Record<string, any>): Promise<StringUUID> {
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
    const response = await fetch(this.baseHttpUrl + `/v1/evals/${evalId}/datapoints/${datapointId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        executorOutput,
        scores,
      }),
    });

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
            data: slicePayload(d.data, 100),
            target: slicePayload(d.target, 100),
          })),
        groupName: groupName ?? null,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  /**
   * Get evaluation datapoints.
   *
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
}
