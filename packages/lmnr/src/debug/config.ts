/**
 * Debug-mode environment parsing.
 *
 * Reads the `LMNR_DEBUG*` env vars once at SDK init and produces an immutable
 * DebugConfig. See the shared debugger spec (§4, §5) for the authoritative
 * contract. This file is part of the cross-language parity surface — keep its
 * logic line-comparable with the Python `config.py`.
 */

import { randomUUID } from "node:crypto";

import { type DebugContext } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";
import { readDebugSessionFile } from "./debug-session-file";

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
  // True ONLY when the SDK minted a fresh session id — i.e. neither
  // LMNR_DEBUG_SESSION_ID nor an existing `.lmnr/debug-session.json` supplied
  // one. Gates the one-time browser open: a reused session id (explicit env or a
  // continuation from the file) is NOT a fresh run, so the browser is not
  // reopened.
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
 * The `.lmnr/debug-session.json` file is now DEFAULT-ON: it is read
 * unconditionally (no opt-in env gate). The decision tree:
 *
 *  1. Read the file (best-effort → `existing | null`).
 *  2. `sessionId` precedence: `LMNR_DEBUG_SESSION_ID` → `existing.session_id` →
 *     a freshly-minted UUID.
 *  3. `sessionMinted` is true ONLY when we minted (neither env nor file supplied
 *     a session id). A file-present run is a CONTINUATION: it rejoins the same
 *     session silently (no browser).
 *  4. `replayTraceId`: `LMNR_DEBUG_REPLAY_TRACE_ID` → `existing.replay_trace_id`
 *     → null. NOTE: continuation is NOT auto-replay — we do NOT promote the prior
 *     run's `trace_id` into `replayTraceId`. Replay is armed explicitly by the
 *     agent via the env var or the file's `replay_trace_id`.
 *  5. `cacheUntilSpanId`: parsed from `LMNR_DEBUG_CACHE_UNTIL ??
 *     existing.cache_until`.
 */
export const buildDebugConfig = (): DebugConfig | null => {
  if (!isTruthy(process.env.LMNR_DEBUG)) {
    return null;
  }

  const existing = readDebugSessionFile();

  const providedSessionId =
    process.env.LMNR_DEBUG_SESSION_ID || existing?.session_id || undefined;
  const sessionId = providedSessionId || randomUUID();
  // The browser is opened once per fresh run; a reused session id (explicit env
  // OR a continuation from the file) is NOT a fresh run, so it is not reopened.
  const sessionMinted = providedSessionId === undefined;
  // Continuation is NOT replay: only an explicit replay trace (env or the file's
  // `replay_trace_id`) arms replay. The prior run's `trace_id` is never promoted.
  const replayTraceId =
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID ||
    existing?.replay_trace_id ||
    null;
  const cacheUntilValue =
    process.env.LMNR_DEBUG_CACHE_UNTIL ?? existing?.cache_until ?? undefined;
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
