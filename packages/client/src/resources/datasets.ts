import { Datapoint, Dataset, GetDatapointsResponse, PushDatapointsResponse } from "@lmnr-ai/types";

import { initializeLogger, StringUUID } from "../utils";
import { BaseResource } from ".";

const logger = initializeLogger();
const DEFAULT_DATASET_PULL_LIMIT = 100;
const DEFAULT_DATASET_PUSH_BATCH_SIZE = 100;

export class DatasetsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * List all datasets.
   *
   * @returns {Promise<Dataset[]>} Array of datasets
   */
  public async listDatasets(): Promise<Dataset[]> {
    const response = await fetch(this.baseHttpUrl + "/v1/datasets", {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<Dataset[]>;
  }

  /**
   * Get a dataset by name.
   *
   * @param {string} name - Name of the dataset
   * @returns {Promise<Dataset[]>} Array of datasets with matching name
   */
  public async getDatasetByName(name: string): Promise<Dataset[]> {
    const params = new URLSearchParams({ name });
    const response = await fetch(
      this.baseHttpUrl + `/v1/datasets?${params.toString()}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<Dataset[]>;
  }

  /**
   * Push datapoints to a dataset.
   *
   * @param {Object} options - Push options
   * @param {Datapoint<D, T>[]} options.points - Datapoints to push
   * @param {string} [options.name] - Name of the dataset (either name or id must be provided)
   * @param {StringUUID} [options.id] - ID of the dataset (either name or id must be provided)
   * @param {number} [options.batchSize] - Batch size for pushing (default: 100)
   * @param {boolean} [options.createDataset] - Whether to create the dataset if it doesn't exist
   * @returns {Promise<PushDatapointsResponse | undefined>}
   */
  public async push<D, T>({
    points,
    name,
    id,
    batchSize = DEFAULT_DATASET_PUSH_BATCH_SIZE,
    createDataset = false,
  }: {
    points: Datapoint<D, T>[];
    name?: string;
    id?: StringUUID;
    batchSize?: number;
    createDataset?: boolean;
  }): Promise<PushDatapointsResponse | undefined> {
    if (!name && !id) {
      throw new Error("Either name or id must be provided");
    }

    if (name && id) {
      throw new Error("Only one of name or id must be provided");
    }

    if (createDataset && !name) {
      throw new Error("Name must be provided when creating a new dataset");
    }

    const identifier = name ? { name } : { datasetId: id! };
    const totalBatches = Math.ceil(points.length / batchSize);

    let response: PushDatapointsResponse | undefined;
    for (let i = 0; i < points.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      logger.debug(`Pushing batch ${batchNum} of ${totalBatches}`);

      const batch = points.slice(i, i + batchSize);
      const fetchResponse = await fetch(
        this.baseHttpUrl + "/v1/datasets/datapoints",
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            ...identifier,
            datapoints: batch.map((point) => ({
              data: point.data,
              target: point.target ?? {},
              metadata: point.metadata ?? {},
            })),
            createDataset,
          }),
        },
      );

      // 201 when creating a new dataset
      if (fetchResponse.status !== 200 && fetchResponse.status !== 201) {
        await this.handleError(fetchResponse);
      }

      response = (await fetchResponse.json()) as PushDatapointsResponse;
    }

    return response;
  }

  /**
   * Pull datapoints from a dataset.
   *
   * @param {Object} options - Pull options
   * @param {string} [options.name] - Name of the dataset (either name or id must be provided)
   * @param {StringUUID} [options.id] - ID of the dataset (either name or id must be provided)
   * @param {number} [options.limit] - Maximum number of datapoints to return (default: 100)
   * @param {number} [options.offset] - Offset for pagination (default: 0)
   * @returns {Promise<GetDatapointsResponse<D, T>>}
   */
  public async pull<D, T>({
    name,
    id,
    limit = DEFAULT_DATASET_PULL_LIMIT,
    offset = 0,
  }: {
    name?: string;
    id?: StringUUID;
    limit?: number;
    offset?: number;
  }): Promise<GetDatapointsResponse<D, T>> {
    if (!name && !id) {
      throw new Error("Either name or id must be provided");
    }

    if (name && id) {
      throw new Error("Only one of name or id must be provided");
    }

    const paramsObj: Record<string, string> = {
      offset: offset.toString(),
      limit: limit.toString(),
    };

    if (name) {
      paramsObj.name = name;
    } else {
      paramsObj.datasetId = id!;
    }

    const params = new URLSearchParams(paramsObj);

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

    return response.json() as Promise<GetDatapointsResponse<D, T>>;
  }
}
