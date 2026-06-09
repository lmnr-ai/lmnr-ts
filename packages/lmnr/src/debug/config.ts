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

import { type DebugContext } from "@lmnr-ai/types";

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
  // True when this process is the ORIGIN of the debug run (config built from
  // local env vars). False when inherited from an upstream service via a
  // propagated LaminarSpanContext debug block — a downstream run must not open
  // the browser or emit the run pointer (the origin owns both).
  localOrigin: boolean;
  // True when the SDK minted a fresh session id (neither LMNR_DEBUG_SESSION_ID
  // nor a last-run pointer supplied one). Gates the one-time browser open: a
  // reused session id is a continuation/replay, so the browser is not reopened.
  sessionMinted: boolean;
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

  const providedSessionId =
    process.env.LMNR_DEBUG_SESSION_ID ||
    (lastRun.session_id as string | undefined);
  const sessionId = providedSessionId || randomUUID();
  // The browser is opened once per fresh run; a reused (provided) session id is
  // a continuation/replay, so it is not reopened.
  const sessionMinted = providedSessionId === undefined;
  const replayTraceId =
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID ||
    (lastRun.trace_id as string | undefined) ||
    null;
  const lastRunCacheUntil =
    typeof lastRun.cache_until === "string" ? lastRun.cache_until : undefined;
  const cacheUntilValue =
    process.env.LMNR_DEBUG_CACHE_UNTIL ?? lastRunCacheUntil;
  const cacheUntilSpanId = parseCacheUntil(cacheUntilValue);

  return {
    sessionId,
    replayTraceId,
    cacheUntilSpanId,
    localOrigin: true,
    sessionMinted,
  };
};

/**
 * Build a debug config from a propagated `DebugContext` (the inherited path).
 *
 * Unlike `buildDebugConfig` (which reads `LMNR_DEBUG*`), this consumes the debug
 * block carried inside a `LaminarSpanContext` that arrived from an upstream
 * service. Keep line-comparable with the Python `build_debug_config_from_context`.
 *
 * Returns null when the block is absent or not armed (`enabled` falsey). We are
 * the only producer, so an unarmed/forged block is treated as absent (behaviour
 * explicitly undefined). A block with no session id is also ignored — without
 * it the run can't be tied to a cache window.
 *
 * The resulting config is `localOrigin: false`: a downstream run reuses the
 * upstream session and may consult the cache, but must NOT open a browser or
 * emit the run pointer (the origin owns those).
 */
export const buildDebugConfigFromContext = (
  debug: DebugContext | undefined,
): DebugConfig | null => {
  if (!debug || !debug.enabled || !debug.sessionId) {
    return null;
  }
  // The needle is propagated verbatim; re-run it through the same parser the
  // env path uses so a downstream config holds an identical needle form.
  const cacheUntilSpanId = parseCacheUntil(debug.cacheUntil);
  return {
    sessionId: debug.sessionId,
    replayTraceId: debug.replayTraceId ?? null,
    cacheUntilSpanId,
    localOrigin: false,
    sessionMinted: false,
  };
};
