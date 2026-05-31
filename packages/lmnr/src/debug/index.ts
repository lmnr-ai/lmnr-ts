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
import { buildDebugConfig, DebugConfig, replayEnabledForConfig } from "./config";
import { buildPointer, emitPointer } from "./pointer";
import { ReplayCache } from "./replay-cache";
import { fetchSpineMetadata, fetchSpinePayloads, SqlQuery } from "./source-trace";
import { detectSpine, hasOverlap } from "./spine";

const logger = initializeLogger();

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
  private _traceId: string | null = null;
  private _emitted = false;

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
   * Return the cached payload to replay for the next occurrence, or undefined.
   *
   * Increments the per-path occurrence counter as a side effect, mirroring a
   * live call consuming one slot of the cache window.
   */
  getCached(spanPath: string): CachedSpan | undefined {
    if (this._cache === null) {
      return undefined;
    }
    const occurrence = this._cache.nextOccurrence(spanPath);
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
      debuggerUrl: this._debuggerUrl,
    });
    emitPointer(pointer);
  }
}

let runtime: DebugRuntime | null = null;
let initialized = false;

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
    return { runtime, ready: Promise.resolve() };
  }
  initialized = true;

  const config = buildDebugConfig();
  if (config === null) {
    return { runtime: null, ready: Promise.resolve() };
  }

  runtime = new DebugRuntime(config, null, debuggerUrl);
  const built = runtime;

  if (!replayEnabledForConfig(config)) {
    return { runtime: built, ready: Promise.resolve() };
  }

  const ready = buildCache(client, config)
    .then((cache) => {
      built.setCache(cache);
    })
    .catch((e) => {
      logger.warn(
        `Failed to build replay cache for ${config.replayTraceId}; ` +
          `running live: ${String(e)}`,
      );
    });

  return { runtime: built, ready };
};

/** Reset module state. Test-only seam, mirrors Python's `_reset_runtime`. */
export const resetRuntimeForTesting = (): void => {
  runtime = null;
  initialized = false;
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
