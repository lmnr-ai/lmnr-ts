/**
 * Spine detection over a source trace's spans.
 *
 * Implements the authoritative heuristic plus the overlap guard.
 * Part of the cross-language parity surface — keep line-comparable with the
 * Python `spine.py` and cover with the shared test vectors.
 */

import { initializeLogger } from "../utils";

const logger = initializeLogger();

// Span-path segment separator. Matches the backend `flat_path` join (".").
export const PATH_SEPARATOR = ".";

/** The minimal span fields spine detection needs. */
export interface SpanRecord {
  spanPath: string;
  spanType: string;
  startTime: number;
  endTime: number;
  // The span's UUID (as stored in ClickHouse). Used to resolve a span-id
  // `LMNR_DEBUG_CACHE_UNTIL` to an occurrence count; "" when unavailable.
  spanId: string;
}

export interface SpineResult {
  spinePath: string | null;
  // Spine calls in execution order (by startTime). Empty when no spine.
  spineCalls: SpanRecord[];
}

/** Number of path segments. Identical computation in both SDKs. */
const depth = (spanPath: string): number => {
  if (!spanPath) {
    return 0;
  }
  return spanPath.split(PATH_SEPARATOR).length;
};

/**
 * Compute the spine over a fetched source trace.
 *
 * Returns the chosen spinePath and its calls sorted by startTime. spinePath is
 * null only when the trace has zero LLM spans.
 */
export const detectSpine = (spans: SpanRecord[]): SpineResult => {
  const llmSpans = spans.filter((s) => ["LLM", "CACHED"].includes(s.spanType));
  if (llmSpans.length === 0) {
    logger.warn("Source trace has no LLM spans; nothing to cache.");
    return { spinePath: null, spineCalls: [] };
  }

  const groups = new Map<string, SpanRecord[]>();
  for (const s of llmSpans) {
    const group = groups.get(s.spanPath);
    if (group) {
      group.push(s);
    } else {
      groups.set(s.spanPath, [s]);
    }
  }

  const candidates = [...groups.entries()].filter(
    ([, calls]) => calls.length >= 2,
  );

  let spinePath: string;
  if (candidates.length > 0) {
    // Primary rule: shallowest looping path; tie-break by earliest start.
    spinePath = candidates
      .map(([path, calls]) => ({
        path,
        depth: depth(path),
        earliest: Math.min(...calls.map((c) => c.startTime)),
      }))
      .sort((a, b) => a.depth - b.depth || a.earliest - b.earliest)[0].path;
  } else {
    // Fallback: shallowest single LLM call site; tie-break by earliest start.
    spinePath = [...llmSpans].sort(
      (a, b) =>
        depth(a.spanPath) - depth(b.spanPath) || a.startTime - b.startTime,
    )[0].spanPath;
  }

  const spineCalls = [...groups.get(spinePath)!].sort(
    (a, b) => a.startTime - b.startTime,
  );
  return { spinePath, spineCalls };
};

/**
 * True if `needle` (hyphen-stripped lowercase hex) suffix-matches `spanId`.
 *
 * The source-trace span ids are full UUIDs, but the user may pass a full UUID,
 * the last two groups, the raw 16-hex OTel id, or a short hex suffix — all of
 * which are a suffix of the hyphen-stripped UUID. Identical logic in both SDKs.
 */
const matchSpanId = (needle: string, spanId: string): boolean => {
  if (needle.length === 0 || spanId.length === 0) {
    return false;
  }
  return spanId.toLowerCase().replace(/-/g, "").endsWith(needle);
};

/**
 * Resolve a span-id `cacheUntil` to an occurrence count over the spine.
 *
 * The spine calls are in execution order, so the matched span's 1-based index
 * is the number of calls to cache (inclusive of the target). Returns null when
 * the needle matches none of the spine calls (invalid / not on the spine path)
 * so the caller can warn and degrade to live.
 */
export const resolveCacheUntilSpanId = (
  spineCalls: SpanRecord[],
  needle: string,
): number | null => {
  for (let i = 0; i < spineCalls.length; i++) {
    if (matchSpanId(needle, spineCalls[i].spanId)) {
      return i + 1;
    }
  }
  return null;
};

/**
 * True if any of the first N spine calls overlap in [start, end).
 *
 * v1 assumes the spine is sequential; overlapping calls mean we cannot safely
 * map occurrence index to a cached response, so the caller must fail loud.
 */
export const hasOverlap = (spineCalls: SpanRecord[], n: number): boolean => {
  const window = [...spineCalls.slice(0, n)].sort(
    (a, b) => a.startTime - b.startTime,
  );
  for (let i = 1; i < window.length; i++) {
    if (window[i].startTime < window[i - 1].endTime) {
      return true;
    }
  }
  return false;
};
