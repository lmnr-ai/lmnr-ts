// Narrow LOCAL interfaces for the Vercel AI SDK "harness" feature
// (`@ai-sdk/harness-claude-code`, `@ai-sdk/harness-codex`, `@ai-sdk/harness-pi`).
//
// The harness packages are EXPERIMENTAL and not installed — we do NOT take a
// peer dependency on them. Every field is optional and read defensively, exactly
// like the Mastra exporter and Temporal instrumentation do with their host
// frameworks. Mirrors the structural-typing style of `v7-integration/types.ts`.

import type { Context, HrTime, Span } from "@opentelemetry/api";

/** A harness `result` returned by `generate()` / `stream()`. */
export interface HarnessResultLike {
  /** Final assistant text for the turn. */
  text?: string;
  /**
   * Stream parts (only on `stream()` results). Typed as `unknown` because some
   * harnesses expose a non-async-iterable wrapper; `consumeHarnessStream`
   * probes for `Symbol.asyncIterator` defensively.
   */
  stream?: unknown;
  /** Per-step records, if the harness exposes them. */
  steps?: unknown[];
  /** Aggregated token usage for the turn. */
  usage?: HarnessUsageLike;
  /** Response messages produced during the turn. */
  responseMessages?: unknown[];
  /** Some harnesses surface a terminal finish reason. */
  finishReason?: string;
  [k: string]: unknown;
}

/** Token-usage shape — superset tolerated by `applyUsageToSpan`. */
export interface HarnessUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: Record<string, unknown>;
  outputTokenDetails?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A single part yielded by a harness `result.stream`, discriminated on `type`. */
export interface HarnessStreamPart {
  /**
   * e.g. `text-delta`, `text`, `reasoning`, `reasoning-delta`, `tool-call`,
   * `tool-result`, `tool-input-start`, dynamic provider-executed parts such as
   * `compaction` / `workspace-file-change`, lifecycle markers, etc.
   */
  type?: string;
  id?: string;
  text?: string;
  delta?: string;
  // tool-call / tool-result fields
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  // provider-executed / dynamic part payloads
  providerExecuted?: boolean;
  dynamic?: boolean;
  [k: string]: unknown;
}

/** Options passed to `generate()` / `stream()` / `continueGenerate()` / `continueStream()`. */
export interface HarnessGenerateOptionsLike {
  session?: HarnessSessionLike;
  prompt?: unknown;
  messages?: unknown[];
  /**
   * Standard AI SDK cancellation signal. When the caller aborts a turn we end
   * the turn span as a deliberate cancellation (UNSET status + abort marker,
   * mirroring v7 `onAbort`) rather than leaking it open or reporting OK.
   */
  abortSignal?: AbortSignal;
  [k: string]: unknown;
}

/** A harness session handle. */
export interface HarnessSessionLike {
  id?: string;
  destroy?: () => unknown;
  detach?: () => unknown;
  stop?: () => unknown;
  suspendTurn?: () => unknown;
  [k: string]: unknown;
}

/** Structural view of a `HarnessAgent` instance — only the methods we wrap. */
export interface HarnessAgentLike {
  harness?: unknown;
  generate?: (options: HarnessGenerateOptionsLike) => unknown;
  stream?: (options: HarnessGenerateOptionsLike) => unknown;
  continueGenerate?: (options: HarnessGenerateOptionsLike) => unknown;
  continueStream?: (options: HarnessGenerateOptionsLike) => unknown;
  createSession?: (options?: unknown) => unknown;
  [k: string]: unknown;
}

/** Internal handle returned by `openHarnessTurnSpan`. */
export interface HarnessTurnSpanHandle {
  span: Span;
  ctx: Context;
  /** Whether the wrapper should synthesize stream-child spans (recordOutputs). */
  recordOutputs: boolean;
  recordInputs: boolean;
  /**
   * Set the turn-span output + usage + finish reason from a result and close
   * it. Idempotent — only the FIRST terminal call (this / `error` / `abort`)
   * takes effect. The wrapper finishes the turn EAGERLY from the resolved
   * result (so a never-iterated present stream can never leak the span open);
   * the consumer's `finally` and an abort/error listener may all race to be
   * first, and the rest no-op.
   */
  finishFromResult: (result: HarnessResultLike | undefined) => void;
  /**
   * Commit the DEFERRED physical end of the turn span. `finishFromResult`
   * settles the turn DATA eagerly but defers the physical `span.end()` so the
   * stream consumer can still record a mid-iteration `stream.error` event on the
   * LIVE span (OTel drops events added after `end()`); the consumer's `finally`
   * calls this once it is done. Idempotent — a no-op if the span was already
   * ended (by the macrotask fallback or a synchronous `error()` / `abort()`).
   */
  finishTurnSpan: () => void;
  /**
   * Pause the idle-fallback that commits the deferred physical end. The consumer
   * calls this right before each `await iterator.next()` so a slow PRODUCER
   * (parts arriving across macrotasks) can't let the fallback end the span
   * mid-drain and drop the mid-iteration `stream.error` / dynamic-marker events
   * the deferral preserves. Idempotent.
   */
  pauseFallbackEnd: () => void;
  /**
   * (Re-)arm the idle-fallback. The consumer calls this right before each
   * `yield` (handing control to the user) so a consumer that receives a part and
   * then ABANDONS the iterator without draining / `return()`ing still gets the
   * turn span committed on the next idle macrotask instead of leaking it open. A
   * consumer that loops promptly re-enters and pauses it within microtasks,
   * before the `setTimeout(0)` fires. Idempotent. No-op once the span is ended.
   */
  armFallbackEnd: () => void;
  /** Close the turn span and any open children as an error. Idempotent. */
  error: (err: unknown) => void;
  /** Close the turn span and any open children as a (non-error) abort. Idempotent. */
  abort: (reason?: unknown) => void;
  /**
   * Register a synthesized child (LLM / TOOL) span so the close paths can end
   * it before the parent and clamp the parent's endTime. Called by
   * `stream-consumer`.
   */
  registerChild: (child: Span) => void;
  /**
   * True once the turn span has been closed by `error()` / `abort()` — a
   * terminal that pre-empts the normal result-driven close. The stream consumer
   * reads this to SKIP synthesizing children after such a close: an abort/error
   * already ended the turn, so creating a child span then would put its endTime
   * after the already-ended parent, violating `child.endTime <= parent.endTime`
   * (issue #2). It stays FALSE on the normal `finishFromResult` close so the
   * consumer still synthesizes children (clamped to `parentEndTime`).
   */
  isFinished: () => boolean;
  /**
   * The turn span's endTime once finished (undefined while still open). The
   * consumer clamps every synthesized child's `.end()` to this value so a child
   * created AFTER the parent was eagerly finished still ends at-or-before the
   * parent — same clamp `endOrphanChildSpansForCallId` applies in the v7 path.
   */
  parentEndTime: () => HrTime | undefined;
}
