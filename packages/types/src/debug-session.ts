/**
 * Shared `.lmnr/debug-session.json` schema + sync IO helpers.
 *
 * This file is the single source of truth for the persisted debug-session
 * record, consumed by BOTH `@lmnr-ai/lmnr` (the SDK, which reads it at init and
 * writes it at shutdown) and `lmnr-cli` (which resets it via `debug session
 * new`). Keeping the schema and the read/write helpers here avoids drift between
 * the two writers.
 *
 * The IO helpers use synchronous `node:fs` (the SDK reads at init and writes in
 * a `process.once("exit")` hook — both must be synchronous), mirroring the SDK's
 * old `pointer.ts`. They are node-only; a browser consumer that only imports the
 * `DebugSessionFile` TYPE never pulls the `node:fs` import in (tree-shaking drops
 * the unused functions, and the bundle never resolves `node:fs`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persisted debug-session record at `${CWD}/.lmnr/debug-session.json`.
 *
 * This REPLACES the old `.lmnr/last-run.json` pointer. It is the default
 * persistence for a debug run (no opt-in env var): the SDK reads it at init to
 * decide "join existing session vs. mint a new one", and writes it at shutdown.
 * The CLI's `debug session new` resets it with a freshly-minted session.
 *
 * `session_id` is the PRIMARY field read at startup. The remaining fields carry
 * over the replay/observability state the old pointer held so a later run (or
 * the UI/CLI) can reconstruct context.
 */
export interface DebugSessionFile {
  /** Current debug session id (UUID). The thing read at startup. Required. */
  session_id: string;
  /** Root trace id produced by the most recent run in this session, or null. */
  trace_id: string | null;
  /** Replay-source trace id (carried from old pointer.trace_id mapping), or null. */
  replay_trace_id: string | null;
  /** Span-id needle bounding the replay window, or null. Verbatim. */
  cache_until: string | null;
  /** Full per-session debugger URL for this session, or null until known. */
  debugger_url: string | null;
  /** ISO-8601 timestamp this session was created/started. */
  started_at: string;
}

/** Directory the debug-session file lives in, relative to the working dir. */
export const DEBUG_SESSION_DIR = ".lmnr";
/** Filename of the debug-session file inside {@link DEBUG_SESSION_DIR}. */
export const DEBUG_SESSION_FILE = "debug-session.json";

/**
 * Read `${dir ?? cwd}/.lmnr/debug-session.json`.
 *
 * Best-effort: returns null on a missing / unreadable / malformed file, or when
 * the parsed object has no usable `session_id`. The caller treats null as "no
 * existing session" and mints a fresh one.
 */
export const readDebugSessionFile = (
  dir: string = process.cwd(),
): DebugSessionFile | null => {
  try {
    const path = join(dir, DEBUG_SESSION_DIR, DEBUG_SESSION_FILE);
    const data: unknown = JSON.parse(readFileSync(path, { encoding: "utf-8" }));
    if (data === null || typeof data !== "object") {
      return null;
    }
    const record = data as Record<string, unknown>;
    const sessionId = record.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return null;
    }
    return {
      session_id: sessionId,
      trace_id: typeof record.trace_id === "string" ? record.trace_id : null,
      replay_trace_id:
        typeof record.replay_trace_id === "string"
          ? record.replay_trace_id
          : null,
      cache_until:
        typeof record.cache_until === "string" ? record.cache_until : null,
      debugger_url:
        typeof record.debugger_url === "string" ? record.debugger_url : null,
      started_at:
        typeof record.started_at === "string"
          ? record.started_at
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

/**
 * Write the debug-session file to `${dir ?? cwd}/.lmnr/debug-session.json`
 * (mkdir -p first).
 *
 * Best-effort: any IO error is swallowed so a read-only working directory never
 * breaks a run. Returns true when the write succeeded, false otherwise.
 */
export const writeDebugSessionFile = (
  file: DebugSessionFile,
  dir: string = process.cwd(),
): boolean => {
  try {
    const directory = join(dir, DEBUG_SESSION_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, DEBUG_SESSION_FILE), JSON.stringify(file), {
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
};
