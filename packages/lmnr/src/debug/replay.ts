/**
 * Shared replay helpers for the per-provider LLM wrappers (§G, §H).
 *
 * The provider wrappers keep their own cached-response reconstruction and
 * streaming wrappers; everything generic — the replay decision, span-path
 * resolution, and the CACHED span marking — lives here so all providers stay in
 * lockstep with the in-process `ReplayCache`. Part of the cross-language parity
 * surface — keep line-comparable with the Python `replay.py`.
 */

import { CachedSpan } from "@lmnr-ai/types";
import { Span } from "@opentelemetry/api";

import { SPAN_PATH } from "../opentelemetry-lib/tracing/attributes";
import { getRuntime } from "./index";

/** True when this process is a debug run with a replay cache. */
export const replayEnabled = (): boolean => getRuntime() !== null;

/**
 * Resolve the dot-joined span path from a span's attributes.
 *
 * Provider spans are created with `tracer.startSpan()` and aren't registered in
 * Laminar's context, so the path is read from the attribute the processor
 * already set (a string[]; see `LaminarSpanProcessor.onStart`).
 */
export const spanPathFromSpan = (span: Span | undefined | null): string | null => {
  if (!span) {
    return null;
  }
  const pathList = (span as unknown as { attributes?: Record<string, unknown> })
    .attributes?.[SPAN_PATH];
  if (Array.isArray(pathList) && pathList.length > 0) {
    return pathList.join(".");
  }
  return null;
};

/**
 * Advance the occurrence counter and return the payload to replay, or undefined.
 *
 * Always advances the counter (when a runtime exists) so a live call and a
 * replayed call consume the same occurrence slot — keeping the spine's
 * occurrence index aligned across record and replay runs.
 */
export const cachedPayloadFor = (
  spanPath: string | null,
): CachedSpan | undefined => {
  const runtime = getRuntime();
  if (runtime === null || !spanPath) {
    return undefined;
  }
  return runtime.getCached(spanPath);
};

/** Stamp the CACHED boundary attributes the frontend renders (§9). */
export const markSpanCached = (span: Span | undefined | null): void => {
  if (span && span.isRecording()) {
    span.setAttributes({
      "lmnr.span.type": "CACHED",
      "lmnr.span.original_type": "LLM",
    });
  }
};
