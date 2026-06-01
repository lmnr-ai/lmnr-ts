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

export const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && TRUTHY.has(value.trim().toLowerCase());

/** Parse N: clamp <0 to 0, non-numeric to 0 (with a warning). */
const parseCacheUntil = (value: string | undefined): number => {
  if (value === undefined || value === "") {
    return 0;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    logger.warn(
      `LMNR_DEBUG_CACHE_UNTIL=${JSON.stringify(value)} is not an integer; defaulting to 0`,
    );
    return 0;
  }
  return n > 0 ? n : 0;
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
  cacheUntil: number;
}

/** True when a source trace is set and at least one call should replay. */
export const replayEnabledForConfig = (config: DebugConfig): boolean =>
  config.replayTraceId !== null && config.cacheUntil > 0;

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
  const lastRunCacheUntil = lastRun.cache_until as number | undefined;
  const cacheUntilValue =
    process.env.LMNR_DEBUG_CACHE_UNTIL ??
    (lastRunCacheUntil !== undefined && lastRunCacheUntil !== null
      ? String(lastRunCacheUntil)
      : undefined);
  const cacheUntil = parseCacheUntil(cacheUntilValue);

  return { sessionId, replayTraceId, cacheUntil };
};
