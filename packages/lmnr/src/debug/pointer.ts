/**
 * Emit the debug-run pointer (§5, §I).
 *
 * On a debug run we always print one console line prefixed with `LMNR_DEBUG_RUN `
 * followed by compact JSON, then best-effort write the same payload to
 * `${CWD}/.lmnr/last-run.json`. The file write is best-effort: any IO error is
 * swallowed so a read-only working directory never breaks the run.
 *
 * Part of the cross-language parity surface — keep line-comparable with the
 * Python `pointer.py` (identical key order, prefix, and best-effort semantics).
 */

import { DebugRunPointer } from "@lmnr-ai/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initializeLogger } from "../utils";

const logger = initializeLogger();

// Console marker the orchestrating tooling greps for. Must match the Python SDK.
export const CONSOLE_PREFIX = "LMNR_DEBUG_RUN ";

// Pointer file location, relative to the current working directory.
export const POINTER_DIR = ".lmnr";
export const POINTER_FILE = "last-run.json";

/** Build the pointer payload. Key order matches the Python SDK. */
export const buildPointer = (args: {
  traceId: string;
  sessionId: string;
  replayTraceId: string | null;
  cacheUntil: number;
  debuggerUrl: string | null;
}): DebugRunPointer => ({
  trace_id: args.traceId,
  session_id: args.sessionId,
  replay_trace_id: args.replayTraceId,
  cache_until: args.cacheUntil,
  debugger_url: args.debuggerUrl,
  started_at: new Date().toISOString(),
});

/** Print the console line, then best-effort write the pointer file. */
export const emitPointer = (pointer: DebugRunPointer): void => {
  const payload = JSON.stringify(pointer);
  // eslint-disable-next-line no-console
  console.log(`${CONSOLE_PREFIX}${payload}`);
  writePointerFile(payload);
};

const writePointerFile = (payload: string): void => {
  try {
    const directory = join(process.cwd(), POINTER_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, POINTER_FILE), payload, { encoding: "utf-8" });
  } catch (e) {
    logger.debug(`Could not write debug pointer file: ${String(e)}`);
  }
};
