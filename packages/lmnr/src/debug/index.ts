/**
 * In-process debug runtime.
 *
 * A debug run is just a normal process execution started with `LMNR_DEBUG*` env
 * vars. At SDK init the runtime is built once from the environment (§4, §5):
 *
 * 1. Parse `DebugConfig` from the environment.
 * 2. If replay is enabled, fetch the source trace's LLM spans (two-phase),
 *    detect the spine (§7), guard against overlap (§F), and build the in-process
 *    `ReplayCache`. Any failure here degrades to debug-no-replay (warn, never
 *    crash the user's program).
 * 3. The run's pointer (§5) is emitted once at process shutdown, after the root
 *    trace id of this run is known.
 *
 * The provider LLM wrappers consult `getRuntime()` to decide replay-vs-live; init
 * stamps `rollout.session_id` on the trace metadata. When debug mode is off,
 * `getRuntime()` returns null and everything is inert (§8). Part of the
 * cross-language parity surface — keep line-comparable with the Python
 * `debug/__init__.py`.
 */

import { CachedSpan } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";
import {
  buildDebugConfig,
  DebugConfig,
  isTruthy,
  replayEnabledForConfig,
} from "./config";
import { buildPointer, emitPointer } from "./pointer";
import { ReplayCache } from "./replay-cache";
import { fetchSpineMetadata, fetchSpinePayloads, SqlQuery } from "./source-trace";
import { detectSpine, hasOverlap } from "./spine";

const logger = initializeLogger();

export { isTruthy };

/**
 * Holds the immutable debug config plus the optional replay cache.
 *
 * Also tracks the run's root trace id so the pointer (§5) can be emitted once at
 * shutdown, when the trace id is guaranteed to be known.
 */
export class DebugRuntime {
  private readonly _config: DebugConfig;
  private _cache: ReplayCache | null;
  private readonly _debuggerUrl: string | null;
  private _projectId: string | null = null;
  private _traceId: string | null = null;
  private _emitted = false;
  private readonly _counters = new Map<string, number>();
  // Captured at construction (SDK init) so the pointer's `started_at` reflects
  // when the run began, not when the pointer is emitted (shutdown).
  private readonly _startedAt = new Date().toISOString();

  constructor(
    config: DebugConfig,
    cache: ReplayCache | null,
    debuggerUrl: string | null,
  ) {
    this._config = config;
    this._cache = cache;
    this._debuggerUrl = debuggerUrl;
  }

  get sessionId(): string {
    return this._config.sessionId;
  }

  get replayTraceId(): string | null {
    return this._config.replayTraceId;
  }

  /** True when replay is configured for this run (source trace + cache window). */
  get replayConfigured(): boolean {
    return replayEnabledForConfig(this._config);
  }

  /** Install the replay cache once it has been fetched and built (§E). */
  setCache(cache: ReplayCache | null): void {
    this._cache = cache;
  }

  /** Remember the root trace id of this run (first root span wins). */
  recordTraceId(traceId: string): void {
    if (this._traceId === null) {
      this._traceId = traceId;
    }
  }

  /**
   * Remember the backend-resolved project id (first wins).
   *
   * Resolved by the session-register call AFTER construction, so the runtime
   * starts with only the base `debuggerUrl`; this lets `debuggerSessionUrl`
   * upgrade to the full per-session URL once known.
   */
  recordProjectId(projectId: string): void {
    if (this._projectId === null) {
      this._projectId = projectId;
    }
  }

  /**
   * The human-facing debugger URL for this run, or null.
   *
   * Single source of truth for the URL printed to the console AND stored in the
   * run pointer's `debugger_url` field. When the project id is known (register
   * succeeded) it is the full
   * `<base>/project/<projectId>/debugger-sessions/<sessionId>`; otherwise it
   * falls back to the base `debuggerUrl` (null when even that is unset).
   */
  debuggerSessionUrl(): string | null {
    if (this._debuggerUrl === null) {
      return null;
    }
    if (this._projectId === null) {
      return this._debuggerUrl;
    }
    return (
      `${this._debuggerUrl}/project/${this._projectId}` +
      `/debugger-sessions/${this._config.sessionId}`
    );
  }

  /**
   * Return the cached payload to replay for the next occurrence, or undefined.
   *
   * Increments the per-path occurrence counter as a side effect, mirroring a
   * live call consuming one slot of the cache window. The counter is owned by
   * the runtime (not the cache) so it advances even while the cache is still
   * loading (`_cache === null`); otherwise spine calls in that window would run
   * live without consuming a slot and the post-`setCache` calls would replay
   * cached responses meant for earlier occurrences.
   */
  getCached(spanPath: string): CachedSpan | undefined {
    const occurrence = this._counters.get(spanPath) ?? 0;
    this._counters.set(spanPath, occurrence + 1);
    if (this._cache === null) {
      return undefined;
    }
    return this._cache.getCached(spanPath, occurrence);
  }

  /** Emit the run pointer once (console line + best-effort file). */
  emitPointer(): void {
    if (this._emitted) {
      return;
    }
    this._emitted = true;
    const pointer = buildPointer({
      traceId: this._traceId ?? "",
      sessionId: this._config.sessionId,
      replayTraceId: this._config.replayTraceId,
      cacheUntil: this._config.cacheUntil,
      debuggerUrl: this.debuggerSessionUrl(),
      startedAt: this._startedAt,
    });
    emitPointer(pointer);
  }
}

let runtime: DebugRuntime | null = null;
let initialized = false;
// The in-flight cache-build promise from the first `initDebugRuntime` call.
// Returned from the idempotent branch so a second caller awaits the same build
// instead of an already-settled `Promise.resolve()` (which would let replay
// lookups run before `setCache` completes).
let readyPromise: Promise<void> = Promise.resolve();

/** Return the process-wide debug runtime, or null when debug mode is off. */
export const getRuntime = (): DebugRuntime | null => runtime;

/**
 * Build the debug runtime once. Idempotent; safe to call from initialize().
 *
 * The SDK's `initialize()` is synchronous, so the runtime is registered
 * immediately (making `sessionId` available for metadata stamping) and the
 * replay cache — which needs an async source-trace fetch — is filled in the
 * background via `runtime.setCache`. LLM calls that happen before the cache is
 * ready run live; this is acceptable for v1 (an agent's first call comes after
 * a network round-trip anyway).
 *
 * Never throws: a failure to fetch / build the cache degrades the run to
 * debug-no-replay rather than crashing the user's program. Returns a promise
 * that resolves once the cache build has settled, so tests (and callers that
 * can await) get a deterministic point to assert on.
 */
export const initDebugRuntime = (
  client: SqlQuery,
  debuggerUrl: string | null = null,
): { runtime: DebugRuntime | null; ready: Promise<void> } => {
  if (initialized) {
    return { runtime, ready: readyPromise };
  }

  const config = buildDebugConfig();
  if (config === null) {
    // Debug mode is off: nothing was built, so do NOT latch the one-shot flag.
    // Otherwise a later init (e.g. after the env flips LMNR_DEBUG on) would
    // short-circuit until resetDebugRuntime(). The off path only reads env
    // vars, so re-running it on a repeat call is cheap.
    return { runtime: null, ready: Promise.resolve() };
  }
  initialized = true;

  runtime = new DebugRuntime(config, null, debuggerUrl);
  const built = runtime;

  if (!replayEnabledForConfig(config)) {
    return { runtime: built, ready: Promise.resolve() };
  }

  readyPromise = buildCache(client, config)
    .then((cache) => {
      built.setCache(cache);
    })
    .catch((e) => {
      logger.warn(
        `Failed to build replay cache for ${config.replayTraceId}; ` +
          `running live: ${String(e)}`,
      );
    });

  return { runtime: built, ready: readyPromise };
};

/**
 * Reset module state so a later `initDebugRuntime` re-reads `LMNR_DEBUG*`.
 *
 * Called by `Laminar.shutdown()` (which supports a subsequent `initialize()`)
 * and by tests. Without this, the one-shot `initialized` flag would pin the
 * first run's runtime — stale replay cache, session metadata, and a spent
 * pointer — across a shutdown/initialize cycle. Mirrors Python's
 * `reset_debug_runtime`.
 */
export const resetDebugRuntime = (): void => {
  runtime = null;
  initialized = false;
  readyPromise = Promise.resolve();
};

const buildCache = async (
  client: SqlQuery,
  config: DebugConfig,
): Promise<ReplayCache | null> => {
  const traceId = config.replayTraceId!;
  const records = await fetchSpineMetadata(client, traceId);

  const result = detectSpine(records);
  if (result.spinePath === null) {
    return null;
  }

  if (hasOverlap(result.spineCalls, config.cacheUntil)) {
    logger.warn(
      `Spine '${result.spinePath}' of source trace ${traceId} has LLM calls ` +
        "that overlap in time; v1 cannot safely replay a non-sequential " +
        "spine — running live.",
    );
    return null;
  }

  const payloads = await fetchSpinePayloads(client, traceId, result.spinePath);
  return new ReplayCache(result.spinePath, config.cacheUntil, payloads);
};
