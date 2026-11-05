/** Resource for tagging traces. */

import { isStringUUID, otelTraceIdToUUID } from "../utils";
import { BaseResource, type LaminarAuth } from "./index";

export class TagsResource extends BaseResource {
  /** Resource for tagging traces. */
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Tag a trace with a list of tags.
   *
   * @param {string | StringUUID} trace_id - The trace id to tag.
   * @param {string[] | string} tags - The tag or list of tags to add to the trace.
   * @returns {Promise<any>} The response from the server.
   * @example
   * ```javascript
   * import { Laminar, observe, LaminarClient } from "@lmnr-ai/lmnr";
   * Laminar.initialize();
   * const client = new LaminarClient();
   * let traceId: StringUUID | null = null;
   * await observe(
   *   {
   *     name: "my-trace",
   *   },
   *   async () => {
   *     traceId = await Laminar.getTraceId();
   *     await foo();
   *   },
   * );
   *
   * if (traceId) {
   *   await client.tags.tag(traceId, ["tag1", "tag2"]);
   * }
   * ```
   */
  public async tag(trace_id: string, tags: string[] | string): Promise<any> {
    const traceTags = Array.isArray(tags) ? tags : [tags];
    const formattedTraceId = isStringUUID(trace_id)
      ? trace_id
      : otelTraceIdToUUID(trace_id);

    const url = this.baseHttpUrl + "/v1/tag";
    const payload = {
      traceId: formattedTraceId,
      names: traceTags,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      await this.handleError(response);
    }
    return response.json();
  }
}
