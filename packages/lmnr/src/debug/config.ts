/**
 * Debug-mode environment parsing.
 *
 * Reads the `LMNR_DEBUG*` env vars once at SDK init and produces an immutable
 * DebugConfig. See the shared debugger spec (§4, §5) for the authoritative
 * contract. This file is part of the cross-language parity surface — keep its
 * logic line-comparable with the Python `config.py`.
 */

import { randomUUID } from "node:crypto";

import { initializeLogger } from "../utils";

const logger = initializeLogger();

// Truthy set for LMNR_DEBUG, case-insensitive. Must match the Python SDK exactly.
const TRUTHY = new Set(["true", "1", "yes", "on"]);

const isTruthy = (value: string | undefined): boolean =>
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
 */
export const buildDebugConfig = (): DebugConfig | null => {
  if (!isTruthy(process.env.LMNR_DEBUG)) {
    return null;
  }

  const sessionId = process.env.LMNR_DEBUG_SESSION_ID || randomUUID();
  const replayTraceId = process.env.LMNR_DEBUG_REPLAY_TRACE_ID || null;
  const cacheUntil = parseCacheUntil(process.env.LMNR_DEBUG_CACHE_UNTIL);

  return { sessionId, replayTraceId, cacheUntil };
};
