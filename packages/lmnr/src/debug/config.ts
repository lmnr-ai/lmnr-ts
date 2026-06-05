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
 * Parse LMNR_DEBUG_CACHE_UNTIL into a span-id needle.
 *
 * In debug-replay v2 the cache window is ALWAYS a span id (the count form was
 * removed): the server resolves the needle into a stop point. Accepts any
 * UUID-ish shape a user copies from the UI. Returns null for an empty value, and
 * warns (then returns null) for a value that isn't span-id shaped.
 */
const parseCacheUntil = (value: string | undefined): string | null => {
  if (value === undefined || value === "") {
    return null;
  }
  const spanId = normalizeSpanId(value);
  if (spanId !== null) {
    return spanId;
  }
  logger.warn(
    `LMNR_DEBUG_CACHE_UNTIL=${JSON.stringify(value)} is not a span id; ` +
      "ignoring",
  );
  return null;
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
  // Hyphen-stripped lowercase hex needle of the span id that bounds the replay
  // window (LMNR_DEBUG_CACHE_UNTIL). Sent verbatim to the cache endpoint, which
  // resolves it server-side. null when no span id was given — replay is then
  // not configured.
  cacheUntilSpanId: string | null;
}

/**
 * True when both a replay trace and a cache-until span id are set, i.e. at least
 * one call should consult the cache. The server resolves the span-id window, so
 * the SDK only needs both ids present to arm replay.
 */
export const replayEnabledForConfig = (config: DebugConfig): boolean =>
  config.replayTraceId !== null && config.cacheUntilSpanId !== null;

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
  const lastRunCacheUntil =
    typeof lastRun.cache_until === "string" ? lastRun.cache_until : undefined;
  const cacheUntilValue =
    process.env.LMNR_DEBUG_CACHE_UNTIL ?? lastRunCacheUntil;
  const cacheUntilSpanId = parseCacheUntil(cacheUntilValue);

  return { sessionId, replayTraceId, cacheUntilSpanId };
};
