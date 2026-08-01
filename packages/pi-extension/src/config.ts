import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Type-only: the shared `.lmnr/debug-session.json` contract, written by the SDK
// and lmnr-cli. Imported as a type (erased at runtime) so the on-disk shape we
// read here can't silently drift from the writers'. See @lmnr-ai/types.
import type { DebugSessionFile } from "@lmnr-ai/types";

// ----------------- Configuration (wayfinder ticket 3: env-primary) -----------------
// No pi `userConfig` manifest exists, so config comes from process.env. We reuse
// the plain LMNR_* names (Laminar's SDK convention; the CC plugin honored them as
// its primary fallback) and drop CC's CLAUDE_PLUGIN_OPTION_/CC_ layers.

/** Read a plain env var, trimmed; "" when absent. */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

// LMNR_DEBUG truthy set — matches the Laminar SDK (true/1/yes/on), broader than
// our historical "true"-only DEBUG (kept for the log-file gate below).
const DEBUG_TRUTHY = new Set(["true", "1", "yes", "on"]);
export function isDebugEnabled(): boolean {
  return DEBUG_TRUTHY.has(env("LMNR_DEBUG").toLowerCase());
}
export const DEBUG = env("LMNR_DEBUG").toLowerCase() === "true";

/** Read the `session_id` from the nearest `.lmnr/debug-session.json`, walking up from `cwd`. */
function readDebugSessionFile(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    try {
      const raw = fs.readFileSync(path.join(dir, ".lmnr", "debug-session.json"), "utf8");
      const sid = (JSON.parse(raw) as Partial<DebugSessionFile> | null)?.session_id;
      if (typeof sid === "string" && sid) {
        return sid;
      }
    } catch {
      // no file here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Resolve the Laminar debugger (rollout) session id when LMNR_DEBUG is set.
 *
 * Mirrors the SDK's precedence: `LMNR_DEBUG_SESSION_ID` env → nearest
 * `.lmnr/debug-session.json` (written by `lmnr-cli debug session new`) → a
 * freshly-minted UUID. Returns null when debug mode is off — the extension then
 * emits no rollout association and behaves exactly as before.
 */
export function getRolloutSessionId(cwd: string): string | null {
  if (!isDebugEnabled()) {
    return null;
  }
  return env("LMNR_DEBUG_SESSION_ID") || readDebugSessionFile(cwd) || randomUUID();
}

const DEFAULT_MAX_CHARS = 20000;

function parseMaxChars(): number {
  const n = Number.parseInt(env("LMNR_MAX_CHARS"), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}
export const MAX_CHARS = parseMaxChars();

// Cap for a single OTLP export request (connect + response), in seconds.
// A constant for v1 (ticket 3; ticket 6 confirms).
export const EXPORT_TIMEOUT_S = 5.0;

/** Absolute path to the extension's debug log (pi is a TUI — never log to stdout/stderr). */
export function logFile(): string {
  return path.join(os.homedir(), ".pi", "agent", "lmnr-pi-extension.log");
}

export interface LaminarConfig {
  apiKey: string;
  baseUrl: string;
  userId: string | null;
}

/** Resolve Laminar config from env, or null when the API key is absent (fail-open). */
export function getLaminarConfig(): LaminarConfig | null {
  const apiKey = env("LMNR_PROJECT_API_KEY");
  const baseUrl = (env("LMNR_BASE_URL") || "https://api.lmnr.ai").replace(/\/+$/, "");
  const userId = env("LMNR_USER_ID") || null;
  if (!apiKey) {
    return null;
  }
  return { apiKey, baseUrl, userId };
}
