/** Resource for tagging traces. */


import { isStringUUID, otelTraceIdToUUID, StringUUID } from "../../utils";
import { BaseResource } from "./index";

export class TagsResource extends BaseResource {
  /** Resource for tagging traces. */
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Tag a trace with a list of tags. Note that the trace must be ended before
   * tagging it. You may want to call `await Laminar.flush()` after the trace
   * that you want to tag.
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
   * // Make sure this is called outside of traced context.
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
   * // or make sure the trace is ended by this point.
   * await Laminar.flush();
   * if (traceId) {
   *   await client.tags.tag(traceId, ["tag1", "tag2"]);
   * }
   * ```
   */
  public async tag(
    trace_id: string | StringUUID,
    tags: string[] | string,
  ): Promise<any> {
    const traceTags = Array.isArray(tags) ? tags : [tags];
    const formattedTraceId = isStringUUID(trace_id) ? trace_id : otelTraceIdToUUID(trace_id) as StringUUID;

    const url = this.baseHttpUrl + "/v1/tag";
    const payload = {
      "traceId": formattedTraceId,
      "names": traceTags,
    }
    const response = await fetch(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    )
    if (!response.ok) {
      await this.handleError(response);
    }
    return response.json();
  }
}
