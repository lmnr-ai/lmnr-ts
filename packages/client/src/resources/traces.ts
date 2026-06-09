/** Resource for post-factum operations on existing traces. */

import { initializeLogger, isStringUUID, otelTraceIdToUUID } from "../utils";
import { BaseResource, type LaminarAuth } from "./index";

const logger = initializeLogger();

export class TracesResource extends BaseResource {
  /** Resource for post-factum operations on existing traces. */
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Push a metadata patch to an existing trace.
   *
   * The patch is shallow-merged server-side into the trace's existing metadata
   * (`existing || patch`, last-write-wins per top-level key). Useful for
   * attaching post-factum signals — quality scores, human edits, triage labels —
   * to a trace that has already finished. The patch does NOT extend `endTime`
   * or change tokens / cost / top span / tags / span names. `numSpans` is
   * incremented by 1 (paid by the virtual span that carried the patch through
   * the ingestion queue) so the new ClickHouse row beats the prior version on
   * `ReplacingMergeTree(numSpans)`. No row is added to the `spans` table.
   *
   * Compared to `Laminar.setTraceMetadata` (which sets metadata on the
   * currently in-flight trace via OpenTelemetry attributes), this method
   * operates on a finished trace by trace id, so it must be called after the
   * trace has been flushed.
   *
   * A 404 response (the trace was not found in the project — typically because
   * it has not been flushed yet) is logged as a warning and the call returns
   * without throwing, since the 404 may be expected when pushing too soon
   * after the trace run. Pass `failOnNotFound: true` to throw instead (e.g.
   * CLI callers that must report the failure). Any other non-OK status throws.
   *
   * @param traceId - The trace id to push metadata to. Accepts a UUID string
   *   or a 32-char OTel hex trace id.
   * @param metadata - The metadata patch. Top-level keys are merged into the
   *   trace's existing metadata. Must be non-empty (the server rejects empty
   *   patches with 400).
   * @param options - `failOnNotFound`: throw on 404 instead of warn-and-return.
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
   *   await client.traces.pushMetadata(traceId, {
   *     score: 0.85,
   *     reviewer: "alice",
   *     needsReview: false,
   *   });
   * }
   * ```
   */
  public async pushMetadata(
    traceId: string,
    metadata: Record<string, unknown>,
    options?: { failOnNotFound?: boolean },
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
      const message =
        `Trace ${formattedTraceId} not found. The trace may not have been ` +
        "flushed yet — call await Laminar.flush() and retry.";
      if (options?.failOnNotFound) {
        throw new Error(message);
      }
      // Trace not found in this project — likely not flushed yet. Don't throw,
      // but surface a warning so callers debugging an empty patch see it.
      logger.warn(message);
      return;
    }

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
