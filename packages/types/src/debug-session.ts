/**
 * Shared `.lmnr/debug-session.json` contract.
 *
 * Single source of truth for the persisted debug-session record's SHAPE and
 * location, imported by both `@lmnr-ai/lmnr` (the SDK — reads at init, writes at
 * shutdown) and `lmnr-cli` (resets it via `debug session new`). `@lmnr-ai/types`
 * stays type-only (no `node:fs`), so the fs read/write helpers live in each
 * consumer; they all import this interface + the filename consts, which is what
 * keeps the on-disk shape from drifting between writers.
 */

/**
 * Persisted debug-session record at `${CWD}/.lmnr/debug-session.json`.
 *
 * Replaces the old `.lmnr/last-run.json` pointer; it is the default persistence
 * for a debug run (no opt-in env var). `session_id` is the PRIMARY field read at
 * startup to decide "join existing session vs. mint a new one".
 */
export interface DebugSessionFile {
  /** Current debug session id (UUID). The thing read at startup. Required. */
  session_id: string;
  /** Root trace id produced by the most recent run in this session, or null. */
  trace_id: string | null;
  /** Replay-source trace id, or null. */
  replay_trace_id: string | null;
  /** Span-id needle bounding the replay window, or null. Verbatim. */
  cache_until: string | null;
  /** Full per-session debugger URL, or null until known. */
  debugger_url: string | null;
  /** ISO-8601 timestamp this session was created/started. */
  started_at: string;
}

/** Directory the debug-session file lives in, relative to the working dir. */
export const DEBUG_SESSION_DIR = ".lmnr";
/** Filename of the debug-session file inside {@link DEBUG_SESSION_DIR}. */
export const DEBUG_SESSION_FILE = "debug-session.json";
