/**
 * Shared replay helpers for the per-provider LLM wrappers (§G, §H).
 *
 * The provider wrappers keep their own cached-response reconstruction and
 * streaming wrappers; everything generic — the replay decision, span-path
 * resolution, and the CACHED span marking — lives here so all providers stay in
 * lockstep. Part of the cross-language parity surface — keep line-comparable
 * with the Python `replay.py`.
 */

import { Span } from "@opentelemetry/api";

import { SPAN_PATH } from "../opentelemetry-lib/tracing/attributes";
import { getRuntime } from "./index";

/**
 * True when this process is a debug run with replay configured (a replay trace
 * + a cache-until span id). A debug-no-replay run (`LMNR_DEBUG` set but no
 * `LMNR_DEBUG_REPLAY_TRACE_ID` / `LMNR_DEBUG_CACHE_UNTIL`) returns false — the
 * provider wrappers then skip the per-call cache lookup entirely.
 */
export const replayEnabled = (): boolean =>
  getRuntime()?.replayConfigured ?? false;

/**
 * Resolve the dot-joined span path from a span's attributes.
 *
 * Provider spans are created with `tracer.startSpan()` and aren't registered in
 * Laminar's context, so the path is read from the attribute the processor
 * already set (a string[]; see `LaminarSpanProcessor.onStart`).
 */
export const spanPathFromSpan = (
  span: Span | undefined | null,
): string | null => {
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

/** Stamp the CACHED boundary attributes the frontend renders (§9). */
export const markSpanCached = (span: Span | undefined | null): void => {
  if (span && span.isRecording()) {
    span.setAttributes({
      "lmnr.span.type": "CACHED",
      "lmnr.span.original_type": "LLM",
    });
  }
};
