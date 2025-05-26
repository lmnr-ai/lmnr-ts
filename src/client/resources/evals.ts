import { EvaluationDatapoint, GetDatapointsResponse, InitEvaluationResponse } from "../../types";
import { slicePayload } from "../../utils";
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
   * @returns {Promise<InitEvaluationResponse>} Response from the evaluation initialization
   */
  public async init(name?: string, groupName?: string): Promise<InitEvaluationResponse> {
    const response = await fetch(this.baseHttpUrl + "/v1/evals", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: name ?? null, groupName: groupName ?? null }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<InitEvaluationResponse>;
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
