/**
 * In-process debug runtime.
 *
 * A debug run is just a normal process execution started with `LMNR_DEBUG*` env
 * vars. At SDK init the runtime is built once from the environment (§4, §5):
 *
 * 1. Parse `DebugConfig` from the environment.
 * 2. If replay is enabled (a replay trace + a cache-until span id), the provider
 *    LLM wrappers consult the per-call cache endpoint at call time (§9). There is
 *    no source-trace fetch or in-process cache build any more — the server owns
 *    the cache, keyed by the per-call input hash.
 * 3. The run's pointer (§5) is emitted once at process shutdown, after the root
 *    trace id of this run is known.
 *
 * The provider LLM wrappers consult `getRuntime()` to decide replay-vs-live; init
 * stamps `rollout.session_id` on the trace metadata. When debug mode is off,
 * `getRuntime()` returns null and everything is inert (§8). Part of the
 * cross-language parity surface — keep line-comparable with the Python
 * `debug/__init__.py`.
 */

import { type CacheOutcome, RolloutSessionsResource } from "@lmnr-ai/client";
import { type DebugContext } from "@lmnr-ai/types";

import {
  buildDebugConfig,
  buildDebugConfigFromContext,
  DebugConfig,
  isTruthy,
  replayEnabledForConfig,
} from "./config";
import { buildPointer, emitPointer } from "./pointer";

export { isTruthy };

/**
 * Holds the immutable debug config plus the handle used to look up the
 * server-side replay cache per LLM call.
 *
 * Also tracks the run's root trace id so the pointer (§5) can be emitted once at
 * shutdown, when the trace id is guaranteed to be known.
 */
export class DebugRuntime {
  private readonly _config: DebugConfig;
  private _rolloutSessions: RolloutSessionsResource;
  private readonly _debuggerUrl: string | null;
  private _projectId: string | null = null;
  private _traceId: string | null = null;
  private _emitted = false;
  // Captured at construction (SDK init) so the pointer's `started_at` reflects
  // when the run began, not when the pointer is emitted (shutdown).
  private readonly _startedAt = new Date().toISOString();

  constructor(
    config: DebugConfig,
    rolloutSessions: RolloutSessionsResource,
    debuggerUrl: string | null,
  ) {
    this._config = config;
    this._rolloutSessions = rolloutSessions;
    this._debuggerUrl = debuggerUrl;
  }

  /**
   * Swap in a fresh rollout-sessions handle for cache lookups.
   *
   * A from-context runtime can be armed (deep in span creation) BEFORE
   * `initialize()` runs, so its client is built from unset connection args and
   * falls back to env/defaults. Once `initialize()` supplies the real
   * baseUrl/port/api-key, it rebinds the handle so replay `lookupCache` calls
   * reach the same backend as the rest of the SDK. No-op on the local-origin
   * path (the env runtime is only ever built after args are known).
   */
  rebindRolloutSessions(rolloutSessions: RolloutSessionsResource): void {
    this._rolloutSessions = rolloutSessions;
  }

  /** The rollout-sessions handle this runtime routes cache lookups through. */
  get rolloutSessions(): RolloutSessionsResource {
    return this._rolloutSessions;
  }

  /**
   * Refresh the DYNAMIC replay coordinates from a freshly-parsed context config.
   *
   * The transport (client / rollout-sessions handle) is STABLE and reused; only
   * the per-request coordinates move — `sessionId`, `replayTraceId`,
   * `cacheUntilSpanId`. This is what lets a long-lived downstream service follow
   * each incoming request's `LaminarSpanContext` instead of freezing on the very
   * first one. `localOrigin` / `sessionMinted` are part of the run's IDENTITY and
   * never change here (the caller only ever updates a `localOrigin:false`
   * runtime; env-origin config keeps precedence).
   *
   * Returns true when the session id changed, so the caller can re-register the
   * new session and re-stamp `rollout.session_id`.
   */
  updateContextConfig(config: DebugConfig): boolean {
    const configChanged =
      this._config.sessionId !== config.sessionId ||
      this._config.replayTraceId !== config.replayTraceId ||
      this._config.cacheUntilSpanId !== config.cacheUntilSpanId;
    this._config.sessionId = config.sessionId;
    this._config.replayTraceId = config.replayTraceId;
    this._config.cacheUntilSpanId = config.cacheUntilSpanId;
    return configChanged;
  }

  get sessionId(): string {
    return this._config.sessionId;
  }

  get replayTraceId(): string | null {
    return this._config.replayTraceId;
  }

  get cacheUntilSpanId(): string | null {
    return this._config.cacheUntilSpanId;
  }

  /** True when replay is configured for this run (replay trace + cache window). */
  get replayConfigured(): boolean {
    return replayEnabledForConfig(this._config);
  }

  /**
   * True when this process originated the run (config from local env). False
   * when armed from a propagated `DebugContext`: a downstream run reuses the
   * upstream session and may consult the cache, but must not open a browser or
   * emit the run pointer.
   */
  get localOrigin(): boolean {
    return this._config.localOrigin;
  }

  /**
   * True when this run should open the debugger URL in a browser once. Only a
   * local-origin run that minted a fresh session id qualifies: a reused session
   * id (continuation/replay) or a context-armed downstream run must not reopen
   * the browser.
   */
  get shouldOpenBrowser(): boolean {
    return this._config.localOrigin && this._config.sessionMinted;
  }

  /**
   * Look up the server-side replay cache for one LLM call (debug-replay v2).
   *
   * Routes through the runtime (rather than a static `Laminar.client`) so the
   * resource is captured at init and the lookup stays testable. Returns
   * `{ kind: "live" }` defensively when replay isn't fully configured — callers
   * gate on `replayConfigured` first, so this only guards against misuse.
   */
  async lookupCache(inputHash: string): Promise<CacheOutcome> {
    const replayTraceId = this._config.replayTraceId;
    const cacheUntil = this._config.cacheUntilSpanId;
    if (replayTraceId === null || cacheUntil === null) {
      return { kind: "live" };
    }
    return this._rolloutSessions.cache({
      sessionId: this._config.sessionId,
      replayTraceId,
      cacheUntil,
      inputHash,
    });
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
   * Emit the run pointer once (console line + best-effort file).
   *
   * No-op on a downstream run (`localOrigin: false`): a runtime armed from a
   * propagated `DebugContext` joins the upstream replay session and must NOT
   * write a run pointer — the origin owns it. Gated here (not just at the call
   * sites) so `shutdown()` and any exit hook stay safe. Mirrors Python's
   * `emit_pointer`.
   */
  emitPointer(): void {
    if (!this._config.localOrigin) {
      return;
    }
    if (this._emitted) {
      return;
    }
    this._emitted = true;
    const pointer = buildPointer({
      traceId: this._traceId ?? "",
      sessionId: this._config.sessionId,
      replayTraceId: this._config.replayTraceId,
      cacheUntil: this._config.cacheUntilSpanId,
      debuggerUrl: this.debuggerSessionUrl(),
      startedAt: this._startedAt,
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
 * Fully synchronous now: the server owns the replay cache (looked up per call),
 * so there is no source-trace fetch to await. The runtime is registered
 * immediately, making `sessionId` available for metadata stamping and the cache
 * endpoint reachable via `runtime.lookupCache`.
 *
 * Never throws: a null config (debug mode off) simply yields a null runtime.
 */
export const initDebugRuntime = (
  rolloutSessions: RolloutSessionsResource,
  debuggerUrl: string | null = null,
): { runtime: DebugRuntime | null } => {
  if (initialized) {
    return { runtime };
  }

  const config = buildDebugConfig();
  if (config === null) {
    // Debug mode is off: nothing was built, so do NOT latch the one-shot flag.
    // Otherwise a later init (e.g. after the env flips LMNR_DEBUG on) would
    // short-circuit until resetDebugRuntime(). The off path only reads env
    // vars, so re-running it on a repeat call is cheap.
    return { runtime: null };
  }
  initialized = true;

  runtime = new DebugRuntime(config, rolloutSessions, debuggerUrl);
  return { runtime };
};

/**
 * Arm OR refresh the debug runtime from a propagated `DebugContext`.
 *
 * Called deep in span creation when a parent `LaminarSpanContext` carrying a
 * debug block parses — so a downstream service joins the upstream run regardless
 * of how the span originated. The whole point of propagating coordinates through
 * the span context is that they are DYNAMIC: a long-lived downstream service
 * handling many requests must follow each request's `sessionId` / `replayTraceId`
 * / `cacheUntil`, not freeze on the first one it ever saw.
 *
 * So the transport is stable but the coordinates move:
 * - No runtime yet → build one from the context (latch `initialized`).
 * - A `localOrigin` (env) runtime exists → env config wins; leave it untouched.
 *   The local process owns the run; a propagated context must not hijack it.
 * - A `localOrigin:false` (context-armed) runtime exists → REUSE its client and
 *   just refresh the dynamic coordinates from the new context.
 *
 * Returns `{ runtime: null }` without latching when the block is absent /
 * unarmed, so a later valid context can still arm the runtime. Never throws.
 */
export const initDebugRuntimeFromContext = (
  debug: DebugContext | undefined,
  rolloutSessions: RolloutSessionsResource,
  debuggerUrl: string | null = null,
): { runtime: DebugRuntime | null; configChanged: boolean } => {
  const config = buildDebugConfigFromContext(debug);
  if (config === null) {
    return { runtime: runtime, configChanged: false };
  }

  if (runtime !== null) {
    // An env-origin run owns the process — a propagated context never overrides
    // it. A context-armed run, by contrast, tracks the live request: refresh its
    // dynamic coordinates in place and reuse the already-built client.
    if (runtime.localOrigin) {
      return { runtime, configChanged: false };
    }
    const configChanged = runtime.updateContextConfig(config);
    return { runtime, configChanged };
  }

  initialized = true;
  runtime = new DebugRuntime(config, rolloutSessions, debuggerUrl);
  return { runtime, configChanged: true };
};

/**
 * Reset module state so a later `initDebugRuntime` re-reads `LMNR_DEBUG*`.
 *
 * Called by `Laminar.shutdown()` (which supports a subsequent `initialize()`)
 * and by tests. Without this, the one-shot `initialized` flag would pin the
 * first run's runtime — stale session metadata and a spent pointer — across a
 * shutdown/initialize cycle. Mirrors Python's `reset_debug_runtime`.
 */
export const resetDebugRuntime = (): void => {
  runtime = null;
  initialized = false;
};
