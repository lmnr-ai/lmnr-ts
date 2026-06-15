// Opens the DEFAULT "turn" span for a `HarnessAgent.generate/stream` call and
// owns its lifecycle (output / usage / finish-reason on success, error / abort
// paths). Child LLM / TOOL spans synthesized by `stream-consumer` register
// themselves here so the close paths can end them BEFORE the parent and clamp
// the parent endTime to be >= every child endTime (same invariant the v7
// integration enforces in `endOrphanChildSpansForCallId`).

import { errorMessage } from "@lmnr-ai/types";
import {
  type Context,
  type HrTime,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { hrTime } from "@opentelemetry/core";

import { getTracer } from "../../../tracing";
import { SPAN_INPUT, SPAN_OUTPUT, SPAN_TYPE } from "../../../tracing/attributes";
import { LaminarContextManager } from "../../../tracing/context";
import {
  applyFinishReason,
  applyPromptMessages,
  applyUsageToSpan,
  compareHrTime,
  readSpanEndTime,
  serializeJSON,
  standardizedPromptToMessages,
} from "../v7-integration/utils";
import type {
  HarnessGenerateOptionsLike,
  HarnessResultLike,
  HarnessTurnSpanHandle,
} from "./types";

export interface OpenHarnessTurnSpanOptions {
  /** Span name, e.g. `harness.generate` / `harness.stream`. */
  name: string;
  /** The options object passed to `generate()` / `stream()`. */
  options: HarnessGenerateOptionsLike | undefined;
  /** The harness identifier (`agent.harness`), best-effort. */
  harness?: unknown;
  recordInputs?: boolean;
  recordOutputs?: boolean;
}

// Resolve a string label for the `harness.harness` attribute from whatever the
// agent exposes (a string id, or an object with a `name` / `id`).
const harnessLabel = (harness: unknown): string | undefined => {
  if (typeof harness === "string") return harness;
  if (harness && typeof harness === "object") {
    const h = harness as Record<string, unknown>;
    if (typeof h.name === "string") return h.name;
    if (typeof h.id === "string") return h.id;
  }
  return undefined;
};

export const openHarnessTurnSpan = (
  opts: OpenHarnessTurnSpanOptions,
): HarnessTurnSpanHandle => {
  const recordInputs = opts.recordInputs ?? true;
  const recordOutputs = opts.recordOutputs ?? true;

  const parentCtx = LaminarContextManager.getContext();
  const tracer = getTracer();
  const span = tracer.startSpan(opts.name, { kind: SpanKind.CLIENT }, parentCtx);
  const ctx: Context = trace.setSpan(parentCtx, span);

  span.setAttribute(SPAN_TYPE, "DEFAULT");
  const label = harnessLabel(opts.harness);
  if (label) span.setAttribute("harness.harness", label);
  const sessionId = opts.options?.session?.id;
  if (typeof sessionId === "string") {
    span.setAttribute("harness.session.id", sessionId);
  }

  if (recordInputs) {
    const options = opts.options;
    if (options && Array.isArray(options.messages)) {
      // Mirror the StandardizedPrompt path — system + messages → SPAN_INPUT.
      applyPromptMessages(span, { messages: options.messages });
    } else if (options?.prompt !== undefined) {
      const prompt = options.prompt;
      if (typeof prompt === "string") {
        const msgs = standardizedPromptToMessages({
          messages: [{ role: "user", content: prompt }],
        });
        span.setAttribute(SPAN_INPUT, serializeJSON(msgs));
      } else {
        span.setAttribute(SPAN_INPUT, serializeJSON(prompt));
      }
    }
  }

  // Child spans (LLM / TOOL) synthesized by the stream-consumer. Kept here so
  // the close paths can guarantee child.endTime <= parent.endTime.
  const childSpans: Span[] = [];

  // The turn span must be ended EXACTLY once. Multiple terminal triggers can
  // race for a streaming turn (the wrapper's eager `finishFromResult` once the
  // harness call resolves, the consumer's `finally`, an abort listener);
  // whichever fires first wins and the rest no-op. Without this guard a late
  // terminal call would re-`end()` (a no-op in the SDK) but also re-run
  // `endOpenChildren` / overwrite status.
  let finished = false;
  // The turn span's endTime, captured at finish. The stream consumer reads it
  // via `parentEndTime()` to clamp every synthesized child's `.end()` so a
  // child created AFTER the eager finish still ends at-or-before the parent
  // (preserving child.endTime <= parent.endTime). `undefined` while open.
  let turnEndTime: HrTime | undefined;
  // True once the span has been PHYSICALLY ended (`span.end()` called). Distinct
  // from `finished` (which latches when the DATA is settled): the normal
  // streaming path settles data eagerly but defers the physical end so the
  // consumer can still record a `stream.error` event on the live span (OTel
  // drops events after end). Guards `commitTurnEnd` so the span ends EXACTLY
  // once whether the consumer or the fallback gets there first.
  let spanEnded = false;
  // The latest child endTime captured at data-settle time; the physical end is
  // clamped to be >= this so child.endTime <= parent.endTime still holds.
  let pendingEndChildClamp: HrTime | undefined;
  // Macrotask handle for the guaranteed fallback end (cleared once committed).
  // The fallback commits the deferred physical end whenever the turn is settled
  // but NOBODY is actively pulling the stream — i.e. a present-but-never-iterated
  // stream, OR a consumer that received a part and then abandoned the iterator
  // without draining / `return()`ing. The stream consumer PAUSES it (clears)
  // right before each `await iterator.next()` and RE-ARMS it right before each
  // `yield` (handing control to the user). So:
  //   - a slow PRODUCER (parts arriving across macrotasks) can't truncate the
  //     live span: the fallback is paused for the whole duration of `next()`;
  //   - a user who ABANDONS after receiving a part doesn't leak: the re-armed
  //     timer fires on the next idle macrotask and commits;
  //   - a user who loops PROMPTLY re-enters the generator and pauses the timer
  //     within microtasks, before the `setTimeout(0)` macrotask can fire.
  // `unref()`'d so it can never keep the Node process alive on its own.
  let fallbackEndTimer: ReturnType<typeof setTimeout> | undefined;
  // True only when the turn was closed by `error()` / `abort()` (a terminal
  // that pre-empts the normal result-driven close). The stream consumer reads
  // this via `isFinished()` to SKIP child synthesis after such a close: an
  // abort/error already ended the turn, so synthesizing a child then would
  // create a span OUTSIDE the parent window (issue #2). On the normal
  // `finishFromResult` close this stays FALSE so the consumer still synthesizes
  // children (clamped to `parentEndTime`) — that is the whole point of the
  // present-stream path.
  let closedByErrorOrAbort = false;

  // The abort listener (set below when an AbortSignal is supplied) is detached
  // on EVERY terminal path so a normally-completed turn leaves no listener
  // behind. `{ once: true }` alone only detaches AFTER an abort fires — on the
  // normal `finishFromResult` / `error` paths it would stay attached for the
  // AbortController's lifetime, so a caller reusing one controller across many
  // turns (idiomatic per-session/per-request controllers) would accumulate one
  // listener per turn → MaxListenersExceededWarning (same class as the debug
  // exit-hook leak in CLAUDE.md). `detachAbortListener` is idempotent (clears
  // its own reference) and is called from every terminal function under the
  // `finished` guard, so it runs exactly once per turn.
  const abortSignal = opts.options?.abortSignal;
  let abortHandler: (() => void) | undefined;
  const detachAbortListener = (): void => {
    if (
      abortHandler &&
      abortSignal &&
      typeof abortSignal.removeEventListener === "function"
    ) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    abortHandler = undefined;
  };

  const endOpenChildren = (): HrTime | undefined => {
    let latest: HrTime | undefined;
    for (const child of childSpans) {
      // `child.end()` is idempotent in the SDK — a second call is a no-op, so
      // ending an already-closed child here is safe.
      child.end();
      const end = readSpanEndTime(child);
      if (end && (!latest || compareHrTime(end, latest) > 0)) latest = end;
    }
    return latest;
  };

  // Physically end the turn span ONCE and snapshot its endTime so children
  // synthesized AFTER the eager finish (deferred iteration) can be clamped to it
  // via `parentEndTime`. Used by the SYNCHRONOUS terminal paths (`error` /
  // `abort`): they end the span immediately, so they also clear any pending
  // fallback timer and latch `spanEnded` to make a later `commitTurnEnd` no-op.
  const endTurnSpan = (latestChildEnd: HrTime | undefined): void => {
    if (spanEnded) return;
    spanEnded = true;
    if (fallbackEndTimer !== undefined) {
      clearTimeout(fallbackEndTimer);
      fallbackEndTimer = undefined;
    }
    span.end(latestChildEnd);
    turnEndTime = readSpanEndTime(span) ?? latestChildEnd;
  };

  // Commit the DEFERRED physical end (normal `finishFromResult` path). The span
  // DATA was already settled and `turnEndTime` snapshotted at finish time; this
  // only ends the live span at that snapshot. Guarded by `spanEnded` so whichever
  // of the consumer's `finishTurnSpan()` or the macrotask fallback fires first
  // wins and the rest no-op — the span ends EXACTLY once. Ending at the snapshot
  // (>= every child end via `pendingEndChildClamp`) keeps child.endTime <=
  // parent.endTime even for children synthesized during a deferred drain.
  const commitTurnEnd = (): void => {
    if (spanEnded) return;
    spanEnded = true;
    if (fallbackEndTimer !== undefined) {
      clearTimeout(fallbackEndTimer);
      fallbackEndTimer = undefined;
    }
    // Close any children still open BEFORE ending the turn span. On the normal
    // drain the consumer's `finally` already closed them via
    // `finishSynthesizedSpans`, so this is an idempotent no-op. But on an
    // ABANDONED stream the macrotask fallback commits the end WITHOUT the
    // consumer's `finally` ever running — leaving any `harness.tool` child opened
    // on a `tool-call` part leaked open (issue: "abandoned stream leaves open
    // tools"). Ending them here, and extending `turnEndTime` to cover the latest
    // child end (children closed now stamp a live `now()` that may be after the
    // eager-finish snapshot), preserves child.endTime <= parent.endTime — same as
    // the synchronous `endTurnSpan` path used by `error` / `abort`.
    const latestChildEnd = endOpenChildren();
    if (
      latestChildEnd &&
      (turnEndTime === undefined ||
        compareHrTime(latestChildEnd, turnEndTime) > 0)
    ) {
      turnEndTime = latestChildEnd;
    }
    span.end(turnEndTime);
    turnEndTime = readSpanEndTime(span) ?? turnEndTime;
  };

  // Arm the idle-fallback: commit the deferred end on the next macrotask UNLESS
  // someone pauses it first (by re-entering the generator to pull the next
  // part). Idempotent — re-arming an already-armed timer is a no-op. `unref()`
  // so this macrotask can NEVER keep the Node process alive on its own. Called
  // from `finishFromResult` (covers the never-iterated stream) and re-armed by
  // the consumer right before each `yield` (covers an abandoned-after-a-part
  // consumer); paused by the consumer right before each `await next()`.
  const armFallbackEnd = (): void => {
    if (spanEnded || fallbackEndTimer !== undefined) return;
    fallbackEndTimer = setTimeout(commitTurnEnd, 0);
    if (typeof fallbackEndTimer.unref === "function") fallbackEndTimer.unref();
  };

  // Pause the idle-fallback while the consumer is ACTIVELY pulling the stream
  // (around `await iterator.next()`), so a slow PRODUCER whose parts arrive
  // across macrotasks can't let the fallback end the span mid-drain and drop the
  // mid-iteration `stream.error` / dynamic-marker events the deferral preserves.
  const pauseFallbackEnd = (): void => {
    if (fallbackEndTimer !== undefined) {
      clearTimeout(fallbackEndTimer);
      fallbackEndTimer = undefined;
    }
  };

  const finishFromResult = (result: HarnessResultLike | undefined): void => {
    if (finished) return;
    finished = true;
    detachAbortListener();
    if (recordOutputs && result) {
      if (typeof result.text === "string" && result.text.length > 0) {
        span.setAttribute(SPAN_OUTPUT, result.text);
      } else if (Array.isArray(result.responseMessages)) {
        span.setAttribute(SPAN_OUTPUT, serializeJSON(result.responseMessages));
      }
    }
    // Usage + finish reason are metadata — recorded regardless of recordOutputs.
    if (result) {
      applyUsageToSpan(span, result.usage);
      if (typeof result.finishReason === "string") {
        applyFinishReason(span, result.finishReason);
      }
    }
    span.setStatus({ code: SpanStatusCode.OK });
    // EAGER-FINALIZE, DEFERRED PHYSICAL END. The turn-span DATA (output / usage /
    // finish-reason / OK status) is settled NOW from the resolved result, so a
    // never-iterated stream still carries its aggregates. But the physical
    // `span.end()` is deferred so the stream consumer's `finally` can still
    // record a mid-iteration `stream.error` event on the LIVE span (issue #2) —
    // OTel drops events added after `end()`. Snapshot the would-be endTime NOW
    // (so `parentEndTime()` can clamp children synthesized by a deferred drain)
    // and guarantee the end via a macrotask fallback so a dropped / never-
    // iterated stream can NEVER leak the span open (the round-3 no-leak
    // property): whichever of the consumer's `finishTurnSpan()` or the fallback
    // fires first ends it, the other no-ops (`spanEnded` guard).
    pendingEndChildClamp = endOpenChildren();
    turnEndTime = pendingEndChildClamp ?? hrTime();
    armFallbackEnd();
  };

  const error = (err: unknown): void => {
    if (finished) return;
    finished = true;
    closedByErrorOrAbort = true;
    detachAbortListener();
    const message = errorMessage(err);
    span.recordException(err instanceof Error ? err : new Error(message));
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    const latestChildEnd = endOpenChildren();
    endTurnSpan(latestChildEnd);
  };

  // `abort` is wired to the caller's `AbortSignal` (below): a deliberate
  // cancellation of the turn (e.g. the harness's own `session.suspendTurn` /
  // `stop` are typically driven by the same signal AI SDK threads through
  // `generate`/`stream` options) ends the turn span as an abort rather than
  // leaking it open or reporting OK.
  const abort = (reason?: unknown): void => {
    if (finished) return;
    finished = true;
    closedByErrorOrAbort = true;
    // Detach our own listener on the abort path too (idempotent): the handler
    // may have been invoked directly rather than via the event when the signal
    // was already aborted, and removal keeps the contract uniform.
    detachAbortListener();
    // An abort / suspendTurn is a deliberate cancellation, NOT a failure — leave
    // the status UNSET and just record a marker (mirrors v7 `onAbort`).
    span.setAttribute("harness.aborted", true);
    span.addEvent("abort");
    if (reason !== undefined) {
      const reasonStr = errorMessage(reason);
      if (reasonStr.length > 0) {
        span.setAttribute("harness.abortReason", reasonStr);
      }
    }
    const latestChildEnd = endOpenChildren();
    endTurnSpan(latestChildEnd);
  };

  // Honor an AbortSignal on the generate/stream options. This is the real
  // cancellation path AI SDK exposes (`HarnessGenerateOptionsLike.abortSignal`),
  // so we don't need to monkey-patch the unavailable harness package's
  // `suspendTurn`/`stop`/`destroy`. We do NOT use `{ once: true }`: it only
  // detaches after an abort fires, leaking the listener on every
  // normally-completed turn. Instead the handler is kept by reference and
  // `detachAbortListener` removes it on every terminal path (see above), so a
  // reused AbortController accumulates no listeners.
  if (abortSignal && typeof abortSignal.addEventListener === "function") {
    if (abortSignal.aborted) {
      abort(abortSignal.reason);
    } else {
      abortHandler = () => abort(abortSignal.reason);
      abortSignal.addEventListener("abort", abortHandler);
    }
  }

  return {
    span,
    ctx,
    recordOutputs,
    recordInputs,
    finishFromResult,
    error,
    abort,
    // Commit the deferred physical end. Called by the stream consumer's
    // `finally` AFTER it has recorded any mid-iteration `stream.error` event on
    // the still-live span (OTel drops events added after `end()`). No-op if the
    // span was already ended (macrotask fallback, or a synchronous error/abort).
    finishTurnSpan: commitTurnEnd,
    // The consumer PAUSES the idle-fallback around each `await next()` (so a slow
    // producer can't end the span mid-drain) and RE-ARMS it before each `yield`
    // (so a consumer that abandons after a part still gets the span committed by
    // the idle fallback rather than leaking it open).
    pauseFallbackEnd,
    armFallbackEnd,
    // stream-consumer registers synthesized children for endTime clamping.
    registerChild: (child: Span) => {
      childSpans.push(child);
    },
    // Reports the abort/error-close state ONLY (not the normal result close):
    // the consumer skips child synthesis after an abort/error so it never
    // creates a span outside the already-ended parent window. The normal
    // result close leaves this false so children still synthesize + clamp.
    isFinished: () => closedByErrorOrAbort,
    // Report the clamp boundary ONLY once the span is PHYSICALLY ended, NOT at
    // eager data-settle. `finishFromResult` snapshots `turnEndTime` eagerly but
    // DEFERS the physical end; during that live window `commitTurnEnd` will
    // EXTEND `turnEndTime` to cover the latest child end, so a child drained
    // then must keep its REAL start/end (no clamp) — returning the eager
    // snapshot here would pin every normally-drained child to zero duration
    // (its realStart is always after the eager snapshot). Once `spanEnded` (the
    // deferred end committed by the fallback during a macrotask gap, or a
    // synchronous error/abort), the parent can no longer be extended, so a child
    // synthesized after that point IS clamped to the real end. `undefined` while
    // live makes the consumer use live timestamps — exactly the desired no-clamp.
    parentEndTime: () => (spanEnded ? turnEndTime : undefined),
  };
};
