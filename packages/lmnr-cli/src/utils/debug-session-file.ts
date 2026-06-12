import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEBUG_SESSION_DIR, DEBUG_SESSION_FILE, type DebugSessionFile } from "@lmnr-ai/types";

// Coerce an unknown field to a non-empty string, else null — the file is
// best-effort local state that an agent may hand-edit, so every field is
// treated defensively rather than trusted. Mirrors the SDK's read.
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Read `${dir ?? cwd}/.lmnr/debug-session.json`. Best-effort: returns null on a
 * missing / unreadable / malformed file, or one with no usable `session_id`.
 * Mirrors the SDK's reader (`@lmnr-ai/lmnr` `src/debug/debug-session-file.ts`)
 * over the shared `DebugSessionFile` contract from `@lmnr-ai/types`.
 */
export const readDebugSessionFile = (dir: string = process.cwd()): DebugSessionFile | null => {
  try {
    const raw = readFileSync(join(dir, DEBUG_SESSION_DIR, DEBUG_SESSION_FILE), "utf-8");
    const r = JSON.parse(raw) as Record<string, unknown>;
    const session_id = str(r.session_id);
    if (!session_id) return null;
    return {
      session_id,
      trace_id: str(r.trace_id),
      replay_trace_id: str(r.replay_trace_id),
      cache_until: str(r.cache_until),
      debugger_url: str(r.debugger_url),
      started_at: str(r.started_at) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

/**
 * Resolve the session id a debug command should act on: the explicit argument
 * when given, else the `session_id` of `.lmnr/debug-session.json`. Throws an
 * actionable error when neither exists; the command wrapper's error envelope
 * formats it.
 */
export const resolveSessionId = (explicit?: string, dir?: string): string => {
  if (explicit) return explicit;
  const file = readDebugSessionFile(dir);
  if (file?.session_id) return file.session_id;
  throw new Error(
    "No session id given and no .lmnr/debug-session.json found in this " +
    "directory. Pass a session id or run `lmnr-cli debug session new`.",
  );
};

/**
 * Resolve the trace id a trace command should act on: the explicit `--trace-id`
 * value when given, else the `trace_id` of `.lmnr/debug-session.json` (the root
 * trace of the most recent debug run in this directory). Throws an actionable
 * error when neither exists; the command wrapper's error envelope formats it.
 */
export const resolveTraceId = (explicit?: string, dir?: string): string => {
  if (explicit) return explicit;
  const traceId = readDebugSessionFile(dir)?.trace_id;
  if (traceId) return traceId;
  throw new Error(
    "No trace id given and .lmnr/debug-session.json has no trace_id (no debug " +
    "run has completed in this directory yet). Pass --trace-id <id> or run " +
    "your program with LMNR_DEBUG=1 first.",
  );
};

/**
 * Write `${dir ?? cwd}/.lmnr/debug-session.json` (mkdir -p first). Best-effort:
 * swallows IO errors. Shares the `DebugSessionFile` contract + filename consts
 * with the SDK (`@lmnr-ai/types`), so the SDK reads this same file at init to
 * join the session `debug session new` minted.
 */
export const writeDebugSessionFile = (
  file: DebugSessionFile,
  dir: string = process.cwd(),
): boolean => {
  try {
    const directory = join(dir, DEBUG_SESSION_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, DEBUG_SESSION_FILE), JSON.stringify(file), "utf-8");
    return true;
  } catch {
    return false;
  }
};
