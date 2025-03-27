import { SemanticSearchResponse } from "../../types";
import { StringUUID } from "../../utils";
import { BaseResource } from "./index";


export class SemanticSearchResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Perform a semantic search on the given dataset.
   *
   * @param {Object} options - Search options
   * @param {string} options.query - Query to search for
   * @param {UUID} options.datasetId - Dataset ID created in the UI
   * @param {number} [options.limit] - Maximum number of results to return
   * @param {number} [options.threshold] - Lowest similarity score to return
   * @throws {Error} If an error happens while performing the semantic search
   * @returns {Promise<SemanticSearchResponse>} Response from the semantic search
   */
  public async search({
    query,
    datasetId,
    limit,
    threshold,
  }: {
    query: string;
    datasetId: StringUUID;
    limit?: number;
    threshold?: number;
  }): Promise<SemanticSearchResponse> {
    const response = await fetch(this.baseHttpUrl + "/v1/semantic-search", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, datasetId, limit, threshold }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return response.json() as Promise<SemanticSearchResponse>;
  }
}
