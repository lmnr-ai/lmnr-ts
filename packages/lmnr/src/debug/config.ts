/**
 * Debug-mode environment parsing.
 *
 * Reads the `LMNR_DEBUG*` env vars once at SDK init and produces an immutable
 * DebugConfig. See the shared debugger spec (§4, §5) for the authoritative
 * contract. This file is part of the cross-language parity surface — keep its
 * logic line-comparable with the Python `config.py`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initializeLogger } from "../utils";
import { POINTER_DIR, POINTER_FILE } from "./pointer";

const logger = initializeLogger();

// Truthy set for LMNR_DEBUG, case-insensitive. Must match the Python SDK exactly.
const TRUTHY = new Set(["true", "1", "yes", "on"]);

// A span-id needle is hyphen-stripped, lowercased hex of at most 32 chars (a
// full UUID is 32 hex). Must match the Python SDK exactly.
const HEX_RE = /^[0-9a-f]+$/;

export const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && TRUTHY.has(value.trim().toLowerCase());

/**
 * Normalize a span-id-shaped value to a hyphen-stripped lowercase hex needle.
 *
 * Accepts any of the spans a user might copy from the UI: a full UUID
 * (`00000000-0000-0000-0123-456789abcdef`), the last two UUID groups
 * (`0123-456789abcdef`), the raw 16-hex OTel span id (`0123456789abcdef`), or a
 * short hex suffix (`abcdef`). Returns the needle (hyphens removed, lowercased)
 * that `matchSpanId` suffix-matches against a span's UUID, or null when the
 * value isn't span-id-shaped (not hex, empty, or longer than a full UUID).
 */
const normalizeSpanId = (value: string): string | null => {
  const needle = value.trim().toLowerCase().replace(/-/g, "");
  if (needle.length > 0 && needle.length <= 32 && HEX_RE.test(needle)) {
    return needle;
  }
  return null;
};

/**
 * Parse LMNR_DEBUG_CACHE_UNTIL into { cacheUntil, spanId }.
 *
 * The value is either a count N (clamp <0 to 0) or a span id in UUID shape that
 * is resolved to N once the source trace is fetched. A numeric value always
 * wins, so a purely decimal string is treated as a count, never a span id.
 * Returns { cacheUntil: 0, spanId: null } for an empty value and warns (then
 * returns the same) for a value that is neither a number nor a span id.
 */
const parseCacheUntil = (
  value: string | undefined,
): { cacheUntil: number; spanId: string | null } => {
  if (value === undefined || value === "") {
    return { cacheUntil: 0, spanId: null };
  }
  // Number("") is 0 and Number(" 3 ") is 3, but a span id like "0123" is also a
  // finite number — so only treat strictly-integer values as counts and let
  // everything else fall through to span-id parsing.
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed !== "" && Number.isInteger(n) && /^[+-]?\d+$/.test(trimmed)) {
    return { cacheUntil: n > 0 ? n : 0, spanId: null };
  }
  const spanId = normalizeSpanId(value);
  if (spanId !== null) {
    return { cacheUntil: 0, spanId };
  }
  logger.warn(
    `LMNR_DEBUG_CACHE_UNTIL=${JSON.stringify(value)} is neither an integer ` +
      "nor a span id; defaulting to 0",
  );
  return { cacheUntil: 0, spanId: null };
};

/**
 * Read `${CWD}/.lmnr/last-run.json` (the previous run's pointer).
 *
 * Best-effort: a missing / unreadable / malformed file returns {} so the caller
 * silently falls back to env vars. Keep line-comparable with the Python
 * `_load_last_run`.
 */
const loadLastRun = (): Record<string, unknown> => {
  try {
    const path = join(process.cwd(), POINTER_DIR, POINTER_FILE);
    const data: unknown = JSON.parse(readFileSync(path, { encoding: "utf-8" }));
    return data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  } catch (e) {
    logger.debug(`Could not read debug pointer file: ${String(e)}`);
    return {};
  }
};

/** Immutable debug configuration, built once at process start. */
export interface DebugConfig {
  sessionId: string;
  replayTraceId: string | null;
  cacheUntil: number;
  // When LMNR_DEBUG_CACHE_UNTIL was given as a span id rather than a count, this
  // holds the hyphen-stripped lowercase hex needle; `cacheUntil` stays 0 until
  // the source trace is fetched and the needle is resolved to an occurrence
  // count (see `buildCache`). null when the value was a plain count.
  cacheUntilSpanId: string | null;
}

/**
 * True when a source trace is set and at least one call should replay.
 *
 * A span-id cache window also counts as replay-configured even though
 * `cacheUntil` is still 0 — the count is resolved later from the source trace,
 * so gating on `cacheUntil > 0` alone would wrongly treat a span-id run as
 * no-replay before the trace is fetched.
 */
export const replayEnabledForConfig = (config: DebugConfig): boolean =>
  config.replayTraceId !== null &&
  (config.cacheUntil > 0 || config.cacheUntilSpanId !== null);

/**
 * Build the debug config from the environment.
 *
 * Returns null when debug mode is disabled (LMNR_DEBUG falsey/absent) — the
 * caller treats null as "everything inert".
 *
 * When `LMNR_DEBUG_FROM_LAST_RUN` is truthy, seed the config from the previous
 * run's pointer file (`${CWD}/.lmnr/last-run.json`): the file's `trace_id` (the
 * trace that run produced) becomes this run's `replayTraceId`, and its
 * `session_id` / `cache_until` are reused. Individual `LMNR_DEBUG_*` env vars
 * still override per-field, so the agent can replay the last run without
 * copying its ids into the environment by hand.
 */
export const buildDebugConfig = (): DebugConfig | null => {
  if (!isTruthy(process.env.LMNR_DEBUG)) {
    return null;
  }

  const lastRun = isTruthy(process.env.LMNR_DEBUG_FROM_LAST_RUN)
    ? loadLastRun()
    : {};

  const sessionId =
    process.env.LMNR_DEBUG_SESSION_ID ||
    (lastRun.session_id as string | undefined) ||
    randomUUID();
  const replayTraceId =
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID ||
    (lastRun.trace_id as string | undefined) ||
    null;
  const lastRunCacheUntil = lastRun.cache_until as number | undefined;
  const cacheUntilValue =
    process.env.LMNR_DEBUG_CACHE_UNTIL ??
    (lastRunCacheUntil !== undefined && lastRunCacheUntil !== null
      ? String(lastRunCacheUntil)
      : undefined);
  const { cacheUntil, spanId: cacheUntilSpanId } =
    parseCacheUntil(cacheUntilValue);

  return { sessionId, replayTraceId, cacheUntil, cacheUntilSpanId };
};
