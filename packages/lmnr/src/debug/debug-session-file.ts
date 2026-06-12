import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import {
  DEBUG_SESSION_DIR,
  DEBUG_SESSION_FILE,
  type DebugSessionFile,
} from "@lmnr-ai/types";

// Coerce an unknown field to a non-empty string, else null — the file is
// best-effort local state that an agent may hand-edit, so every field is treated
// defensively rather than trusted.
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Read `${dir ?? cwd}/.lmnr/debug-session.json`. Best-effort: returns null on a
 * missing / unreadable / malformed file, or one with no usable `session_id`
 * (the caller treats null as "no existing session" and mints a fresh one).
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
 * Find the nearest directory (walking up from `startDir` to the filesystem
 * root) whose `.lmnr/debug-session.json` holds a usable session record, so a
 * debug run started from a subdirectory of a project joins the project's
 * session. Returns null when no ancestor (including `startDir`) has one.
 */
export const findDebugSessionDir = (startDir: string = process.cwd()): string | null => {
  let dir = resolve(startDir);
  const root = parse(dir).root;
  while (true) {
    if (readDebugSessionFile(dir) !== null) return dir;
    const parent = dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
};

/**
 * The directory the debug-session file should be read from AND written to: the
 * nearest ancestor (incl. `startDir`) that already has one, else `startDir`
 * itself. Read and write MUST share this anchor — reading from an ancestor but
 * writing to cwd would strand the ancestor's copy stale and shadow it with a
 * nested one.
 */
export const resolveDebugSessionDir = (startDir: string = process.cwd()): string =>
  findDebugSessionDir(startDir) ?? resolve(startDir);

/**
 * Write the debug-session file (mkdir -p first). Best-effort: swallows any IO
 * error so a read-only working directory never breaks a run.
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
