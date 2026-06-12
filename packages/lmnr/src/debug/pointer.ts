/**
 * Emit the debug-session record (§5, §I).
 *
 * On a debug run we always print one console line prefixed with `LMNR_DEBUG_RUN `
 * followed by compact JSON, AND write the same payload to
 * `${CWD}/.lmnr/debug-session.json` (default-on now — there is no longer an
 * opt-in env gate). The file write is best-effort (any IO error is swallowed so
 * a read-only working directory never breaks the run) and delegates to the
 * local `writeDebugSessionFile` helper, which writes the SAME shape (the
 * `DebugSessionFile` contract + filename consts from `@lmnr-ai/types`) the CLI
 * writes, so the on-disk file stays consistent across both writers.
 *
 * Part of the cross-language parity surface — keep line-comparable with the
 * Python `pointer.py` (identical prefix and best-effort semantics).
 */

import { type DebugSessionFile } from "@lmnr-ai/types";

import {
  readDebugSessionFile,
  resolveDebugSessionDir,
  writeDebugSessionFile,
} from "./debug-session-file";

// Console marker the orchestrating tooling greps for. Must match the Python SDK.
export const CONSOLE_PREFIX = "LMNR_DEBUG_RUN ";

/**
 * Build the persisted debug-session record.
 *
 * `startedAt` is the run's start time, captured by `DebugRuntime` at SDK init so
 * the record reflects when tracing began rather than when it was emitted
 * (shutdown). Defaults to now for standalone callers.
 */
export const buildDebugSessionFile = (args: {
  sessionId: string;
  traceId: string | null;
  replayTraceId: string | null;
  cacheUntil: string | null;
  debuggerUrl: string | null;
  startedAt?: string;
}): DebugSessionFile => ({
  session_id: args.sessionId,
  trace_id: args.traceId,
  replay_trace_id: args.replayTraceId,
  cache_until: args.cacheUntil,
  debugger_url: args.debuggerUrl,
  started_at: args.startedAt ?? new Date().toISOString(),
});

/**
 * Print the console line, then best-effort write the debug-session file.
 *
 * The pointer is emitted at shutdown (via the `exit` hook / `Laminar.shutdown()`),
 * which can be long after the run started. If a newer session was minted in the
 * meantime — e.g. `lmnr-cli debug session new` reset `.lmnr/debug-session.json`
 * while this (older) process was still running — blindly writing our in-memory
 * session would clobber that fresher session id. So skip the file write when the
 * on-disk `session_id` is present and differs from ours; we no longer own the
 * file. The console marker is always printed regardless.
 *
 * The file location is the nearest-ancestor anchor (`resolveDebugSessionDir`),
 * matching where startup (`config.ts`) read the session from — the guard's
 * re-read and the write must hit the SAME file or the guard is meaningless.
 */
export const emitPointer = (file: DebugSessionFile): void => {
  console.log(`${CONSOLE_PREFIX}${JSON.stringify(file)}`);
  const dir = resolveDebugSessionDir();
  const onDisk = readDebugSessionFile(dir);
  if (onDisk !== null && onDisk.session_id !== file.session_id) {
    return;
  }
  writeDebugSessionFile(file, dir);
};
