/**
 * Fetch a source trace's spans via the existing SQL/query endpoint.
 *
 * Two-phase by default (§9, §E): first pass pulls lightweight spine-detection
 * fields (path/type/times), then a second pass pulls response payloads only for
 * the chosen spine path. This keeps memory bounded since v1 only caches the
 * spine. Part of the cross-language parity surface — keep line-comparable with
 * the Python `source_trace.py`.
 */

import { CachedSpan } from "@lmnr-ai/types";

import { SpanRecord } from "./spine";

// The SQL resource shape we depend on (LaminarClient.sql). Narrowed so the
// debug module does not import the whole client type.
export interface SqlQuery {
  query(
    sql: string,
    parameters?: Record<string, any>,
  ): Promise<Array<Record<string, any>>>;
}

const PAGE_SIZE = 1000;

/**
 * Best-effort conversion of a ClickHouse timestamp to a float epoch (ms).
 *
 * The SQL endpoint returns ISO-8601 strings; fall back to lexical ordering so
 * detection still works even if parsing fails. `missingDefault` is returned for
 * a null / omitted value — callers pass `Infinity` for `end_time` so the §F
 * overlap guard treats an unknown end as overlapping (fail loud, run live)
 * rather than silently passing as 0.
 */
export const toEpoch = (value: any, missingDefault = 0): number => {
  if (value === null || value === undefined) {
    return missingDefault;
  }
  if (typeof value === "number") {
    return value;
  }
  const s = String(value);
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  // Lexical fallback: ISO strings sort chronologically.
  let sum = 0;
  for (const c of s.slice(0, 32)) {
    sum += c.charCodeAt(0);
  }
  return sum;
};

/** Phase 1: lightweight fetch of path / type / times for all spans. */
export const fetchSpineMetadata = async (
  client: SqlQuery,
  traceId: string,
): Promise<SpanRecord[]> => {
  const records: SpanRecord[] = [];
  let offset = 0;
  for (;;) {
    const rows = await client.query(
      "SELECT path, span_type, start_time, end_time FROM spans " +
        "WHERE trace_id = {trace_id:UUID} " +
        "ORDER BY start_time LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
      { trace_id: traceId, limit: PAGE_SIZE, offset },
    );
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      records.push({
        spanPath: row.path || "",
        spanType: String(row.span_type || ""),
        startTime: toEpoch(row.start_time),
        endTime: toEpoch(row.end_time, Infinity),
      });
    }
    if (rows.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return records;
};

/**
 * Phase 2: pull response payloads for the spine path, ordered by start_time.
 *
 * Returns CachedSpan objects ({name, input, output, attributes}) so the
 * per-provider cached-response reconstruction consumes them unchanged.
 */
export const fetchSpinePayloads = async (
  client: SqlQuery,
  traceId: string,
  spinePath: string,
): Promise<CachedSpan[]> => {
  const out: CachedSpan[] = [];
  let offset = 0;
  for (;;) {
    const rows = await client.query(
      "SELECT name, input, output, attributes, start_time FROM spans " +
        "WHERE trace_id = {trace_id:UUID} AND path = {path:String} " +
        "AND span_type = 'LLM' " +
        "ORDER BY start_time LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
      { trace_id: traceId, path: spinePath, limit: PAGE_SIZE, offset },
    );
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      out.push(rowToCachedSpan(row));
    }
    if (rows.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return out;
};

const rowToCachedSpan = (row: Record<string, any>): CachedSpan => {
  let attributes = row.attributes;
  if (typeof attributes === "string") {
    try {
      attributes = JSON.parse(attributes);
    } catch {
      attributes = {};
    }
  }
  return {
    name: row.name || "",
    input: row.input || "",
    output: row.output || "",
    attributes: attributes || {},
  };
};
