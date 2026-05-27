/** Resource for post-factum operations on existing traces. */

import { isStringUUID, otelTraceIdToUUID } from "../utils";
import { BaseResource } from "./index";

export class TracesResource extends BaseResource {
  /** Resource for post-factum operations on existing traces. */
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Merge a metadata patch onto an existing trace.
   *
   * The patch is shallow-merged into the trace's existing metadata server-side
   * (`existing || patch`, last-write-wins per top-level key). Useful for
   * attaching post-factum signals — quality scores, human edits, triage labels —
   * to a trace that has already finished. The patch does NOT extend `endTime`,
   * increment `numSpans`, or otherwise touch trace stats; it also does not add
   * a span to the trace.
   *
   * Compared to `Laminar.setTraceMetadata` (which sets metadata on the
   * currently in-flight trace via OpenTelemetry attributes), this method
   * operates on a finished trace by trace id, so it must be called after the
   * trace has been flushed.
   *
   * A 404 response (the trace was not found in the project — typically because
   * it has not been flushed yet) is silently swallowed; any other non-OK
   * status throws.
   *
   * @param traceId - The trace id to merge metadata onto. Accepts a UUID string
   *   or a 32-char OTel hex trace id.
   * @param metadata - The metadata patch. Top-level keys are merged into the
   *   trace's existing metadata. Must be non-empty (the server rejects empty
   *   patches with 400).
   * @example
   * ```typescript
   * import { Laminar, observe, LaminarClient } from "@lmnr-ai/lmnr";
   * Laminar.initialize();
   * const client = new LaminarClient();
   *
   * let traceId: string | null = null;
   * await observe({ name: "generate" }, async () => {
   *   traceId = await Laminar.getTraceId();
   * });
   * await Laminar.flush();
   *
   * if (traceId) {
   *   await client.traces.mergeMetadata(traceId, {
   *     score: 0.85,
   *     reviewer: "alice",
   *     needsReview: false,
   *   });
   * }
   * ```
   */
  public async mergeMetadata(
    traceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!metadata || Object.keys(metadata).length === 0) {
      throw new Error("metadata must be a non-empty object");
    }

    const formattedTraceId = isStringUUID(traceId)
      ? traceId
      : otelTraceIdToUUID(traceId);

    const url = this.baseHttpUrl + "/v1/traces/metadata";
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        traceId: formattedTraceId,
        metadata,
      }),
    });

    if (response.status === 404) {
      // Trace not found — likely not flushed yet. Don't throw.
      return;
    }

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
