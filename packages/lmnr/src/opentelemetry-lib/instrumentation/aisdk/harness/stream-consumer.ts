// Consumes a harness `result.stream`, re-yielding every part to the user while
// (optionally) synthesizing child LLM / TOOL spans under the turn span.
//
// The turn span is finished EAGERLY by the wrapper from the resolved result
// (see `harness/index.ts`) — this generator does NOT finish the turn. Its only
// job is to synthesize + end CHILD spans during iteration. Because the parent
// is already finished by the time iteration runs (possibly deferred), every
// synthesized child is `.end()`ed clamped to `end = min(realEnd, parentEnd)` so
// child.endTime <= parent.endTime holds. A promptly-drained child keeps its
// REAL start/end (and thus real duration); only the genuinely-after-parent
// (deferred) case degrades to a zero-duration pin at the parent end (see the
// CLAMP MODEL comment below). And once the turn was closed by an abort/error
// (`handle.isFinished()`), synthesis is SKIPPED entirely so no orphan child is
// ever created outside the parent window.
//
// Dedupe: when the per-turn `coreTelemetryFired` flag is TRUE, the harness
// routed its work through Core `generateText` / `streamText` and our v7
// integration already produced the per-step spans — so we ONLY collect text for
// the turn-span output and do NOT synthesize children (avoids doubling).
//
// The stream may be single-consumption. We collect-and-re-yield (like
// `claude-agent-sdk`'s generator) so the user's own `for await` over
// `result.stream` still works. Per CLAUDE.md, each iterator `next()` runs inside
// its own `runWithIsolatedContext` frame so the turn context is visible across
// yields to any nested Laminar instrumentation.

import { errorMessage } from "@lmnr-ai/types";
import {
  type Span,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { hrTime, hrTimeToNanoseconds } from "@opentelemetry/core";

import { getTracer } from "../../../tracing";
import { SPAN_INPUT, SPAN_OUTPUT, SPAN_TYPE } from "../../../tracing/attributes";
import { LaminarContextManager } from "../../../tracing/context";
import {
  buildGenAiOutputMessages,
  serializeJSON,
} from "../v7-integration/utils";
import {
  runWithTurnSignal,
  type TurnSignal,
} from "./core-telemetry-signal";
import type {
  HarnessStreamPart,
  HarnessTurnSpanHandle,
} from "./types";

interface SynthState {
  text: string;
  reasoning: string;
  toolCalls: Array<{ toolCallId?: string; toolName?: string; args: unknown }>;
}

const isAsyncIterable = (
  value: unknown,
): value is AsyncIterable<HarnessStreamPart> =>
  value != null &&
  typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
    "function";

// Pull a text/reasoning delta off a stream part, tolerating both `text` and
// `delta` field names across part shapes.
const partText = (part: HarnessStreamPart): string => {
  if (typeof part.text === "string") return part.text;
  if (typeof part.delta === "string") return part.delta;
  return "";
};

/**
 * Outcome of `consumeHarnessStream`. `consumed: true` means we returned a fresh
 * async-iterable to re-yield in place of `result.stream`; it synthesizes child
 * spans during iteration but does NOT finish the turn span (the wrapper does
 * that eagerly from the result). `consumed: false` means the stream wasn't
 * async-iterable; the caller keeps the original stream. Either way the wrapper
 * owns finishing the turn span, so a dropped/never-iterated stream cannot leak.
 */
export type ConsumeHarnessStreamResult =
  | { consumed: true; stream: AsyncIterable<HarnessStreamPart> }
  | { consumed: false };

/**
 * Wrap a harness stream into a fresh async generator that re-yields each part
 * and synthesizes spans. When `stream` is not async-iterable, returns
 * `{ consumed: false }` so the caller can fall back.
 */
export const consumeHarnessStream = (
  stream: unknown,
  handle: HarnessTurnSpanHandle,
  // Reads this turn's dedupe signal: false once Core telemetry fired during the
  // turn. Re-read per stream part (the flag is monotonic false→true).
  shouldSynthesize: () => boolean,
  // This turn's dedupe signal object. The consumer RE-ESTABLISHES the
  // `runWithTurnSignal` ALS frame around each `iterator.next()` so a harness
  // that routes a step through Core WHILE producing a part (its v7 `onStart`
  // calls `markCoreTelemetryFired`) actually flips THIS turn's flag. Without it
  // the frame opened by the wrapper has already unwound by iteration time, so
  // `markCoreTelemetryFired` would be a no-op and synthesized children would
  // duplicate the v7 spans.
  turnSignal: TurnSignal,
): ConsumeHarnessStreamResult => {
  if (!isAsyncIterable(stream)) return { consumed: false };

  const synth: SynthState = { text: "", reasoning: "", toolCalls: [] };
  // TOOL spans, keyed by toolCallId, opened on tool-call and closed on the
  // matching tool-result. Provider-executed / dynamic tool parts also land here.
  const toolSpans = new Map<string, Span>();

  // CLAMP MODEL. The wrapper settles the parent turn span's DATA eagerly from
  // the resolved result, but DEFERS the physical end. `handle.parentEndTime()`
  // returns a value ONLY once the span is PHYSICALLY ended — `undefined` while
  // still live — because during the live window `commitTurnEnd` EXTENDS the
  // parent end to cover the latest child end, so a child drained then keeps its
  // REAL timing and the parent simply ends at-or-after it. The invariant we must
  // keep is child.endTime <= parent.endTime, WITHOUT needlessly destroying real
  // per-LLM / per-tool timing.
  //
  // So in the COMMON case (normal / deferred drain, parent still live) parentEnd
  // is `undefined` and we use the child's REAL start/end with NO clamp — true
  // duration always survives, including a deferred drain (the parent end is
  // pushed out to cover it at commit). [If we instead keyed the clamp off the
  // EAGER data-settle snapshot, every normally-drained child — whose realStart
  // is always after that snapshot — would be pinned to zero duration. That was
  // cursor[bot] "Synthesized children always zero duration".]
  //
  // parentEnd is only KNOWN once the parent is physically ended (a synchronous
  // error/abort, or the idle-fallback committing during a macrotask gap mid-
  // drain). Then, deciding per child by comparing its REAL start to that end:
  //
  // - realStart <= parentEnd: keep the child's REAL start; clamp only the end
  //   down to end = min(realEnd, parentEnd) (a no-op unless a tail ran past it).
  //
  // - realStart > parentEnd: a child cannot start after its parent ended without
  //   the OTel SDK rejecting the backdated start (it falls back to now()), so we
  //   PIN both start and end to parentEnd — a zero-duration child exactly at the
  //   parent end. Confined to the genuinely-after-physical-end case.
  //
  // Start options for a synthesized child. Use the real start unless parentEnd
  // is known AND the real start would fall AFTER it (after-physical-end case) —
  // then pin the start to parentEnd so the SDK accepts it and the child
  // collapses to zero duration there.
  const childStartOpts = (kind: SpanKind) => {
    const parentEnd = handle.parentEndTime();
    if (parentEnd === undefined) return { kind };
    const realStartNanos = hrTimeToNanoseconds(hrTime());
    if (realStartNanos > hrTimeToNanoseconds(parentEnd)) {
      // After physical end: real start is after the parent already ended — pin.
      return { kind, startTime: parentEnd };
    }
    // Normal: let the SDK stamp the real start (now).
    return { kind };
  };

  // End a synthesized child at min(realEnd, parentEnd) so the child never
  // outlives the parent, while a child whose parent is still live (parentEnd
  // unknown) keeps its real end (and thus its real duration).
  const endChild = (span: Span): void => {
    const parentEnd = handle.parentEndTime();
    if (parentEnd === undefined) {
      span.end();
      return;
    }
    const realEnd = hrTime();
    span.end(
      hrTimeToNanoseconds(realEnd) <= hrTimeToNanoseconds(parentEnd)
        ? realEnd
        : parentEnd,
    );
  };

  const finishSynthesizedSpans = (synthesize: boolean): void => {
    // The turn was already closed by an abort/error — do NOT create or close
    // child spans here. The parent span is ended; synthesizing now would emit a
    // child whose endTime is later than the parent (issue #2). The abort/error
    // path closes the turn directly; any open children would have been ended by
    // the handle's own `endOpenChildren` already.
    if (handle.isFinished()) {
      toolSpans.clear();
      return;
    }
    // When deduping (Core telemetry covered this turn) we must NOT emit ANY
    // synthesized child — the v7 integration already produced the real LLM /
    // TOOL spans, and the turn-span output already carries the assistant text.
    // A TOOL span can be open here when Core telemetry fired LATE: a `tool-call`
    // part opened it before the dedupe flag flipped, and the matching
    // `tool-result` was then skipped (it lives inside the `if (synthesize)`
    // block in `handlePart`). DISCARD it — never `.end()` it (so it's never
    // exported) and unregister it from the turn so the close paths don't end it
    // either (cursor[bot] "Late dedupe duplicates tool spans").
    if (!synthesize) {
      for (const span of toolSpans.values()) handle.unregisterChild(span);
      toolSpans.clear();
      return;
    }
    // Close any still-open TOOL spans (provider never emitted a result part),
    // clamped to the (already-finished) parent endTime.
    for (const span of toolSpans.values()) {
      span.setStatus({ code: SpanStatusCode.OK });
      endChild(span);
    }
    toolSpans.clear();
    // Emit one LLM span carrying the accumulated assistant turn, mirroring the
    // v7 LLM-span output contract (gen_ai.output.messages only).
    if (
      handle.recordOutputs &&
      (synth.text.length > 0 ||
        synth.reasoning.length > 0 ||
        synth.toolCalls.length > 0)
    ) {
      const tracer = getTracer();
      const llmSpan = tracer.startSpan(
        "harness.llm",
        childStartOpts(SpanKind.CLIENT),
        handle.ctx,
      );
      llmSpan.setAttribute(SPAN_TYPE, "LLM");
      handle.registerChild(llmSpan);
      const outputMessages = buildGenAiOutputMessages({
        text: synth.text,
        reasoningText: synth.reasoning,
        toolCalls: synth.toolCalls,
      });
      if (outputMessages) {
        llmSpan.setAttribute("gen_ai.output.messages", outputMessages);
      }
      llmSpan.setStatus({ code: SpanStatusCode.OK });
      endChild(llmSpan);
    }
  };

  const handlePart = (part: HarnessStreamPart, synthesize: boolean): void => {
    const type = part.type ?? "";
    // Always collect text for the turn-span output, even when deduping.
    if (type === "text-delta" || type === "text") {
      synth.text += partText(part);
      return;
    }
    // After an abort/error close the turn span is PHYSICALLY ended — OTel drops
    // any child `.end()` or `addEvent` after that, and a new child would outlive
    // the already-ended parent (issue #2). So do nothing further for any
    // non-text part once the turn is finished.
    if (handle.isFinished()) return;
    // Child-span synthesis (reasoning accumulation + LLM / TOOL spans) is gated
    // by `synthesize`: when Core telemetry covered this turn the v7 integration
    // already produced the per-step spans, so re-synthesizing would double them.
    if (synthesize) {
      if (type === "reasoning-delta" || type === "reasoning") {
        synth.reasoning += partText(part);
        return;
      }
      if (type === "tool-call" || type === "tool-input-available") {
        const toolCallId = part.toolCallId;
        const toolName = part.toolName;
        synth.toolCalls.push({
          toolCallId,
          toolName,
          args: part.input,
        });
        if (toolCallId && !toolSpans.has(toolCallId)) {
          const tracer = getTracer();
          const span = tracer.startSpan(
            `harness.tool ${toolName ?? "unknown"}`,
            childStartOpts(SpanKind.CLIENT),
            handle.ctx,
          );
          span.setAttribute(SPAN_TYPE, "TOOL");
          if (toolName) span.setAttribute("ai.toolCall.name", toolName);
          span.setAttribute("ai.toolCall.id", toolCallId);
          if (handle.recordInputs && part.input !== undefined) {
            const serialized = serializeJSON(part.input);
            span.setAttribute("ai.toolCall.args", serialized);
            span.setAttribute(SPAN_INPUT, serialized);
          }
          handle.registerChild(span);
          toolSpans.set(toolCallId, span);
        }
        return;
      }
      if (type === "tool-result") {
        const toolCallId = part.toolCallId;
        if (toolCallId) {
          const span = toolSpans.get(toolCallId);
          if (span) {
            const output = part.output ?? part.result;
            if (handle.recordOutputs && output !== undefined) {
              const serialized = serializeJSON(output);
              span.setAttribute("ai.toolCall.result", serialized);
              span.setAttribute(SPAN_OUTPUT, serialized);
            }
            span.setStatus({ code: SpanStatusCode.OK });
            endChild(span);
            toolSpans.delete(toolCallId);
          }
        }
        return;
      }
    }
    // Dynamic provider-executed parts (compaction, workspace file changes, ...)
    // — record as a marker EVENT on the turn span so they're visible without
    // forcing a full TOOL span when we don't have a call/result pair. These are
    // recorded REGARDLESS of `synthesize`: they are turn-span events, not
    // synthesized child spans, and the v7 integration never produces these
    // harness-specific markers — so recording them on a Core-routed (deduped)
    // turn can't double anything (the dedupe only suppresses synthesized
    // LLM / TOOL CHILD spans).
    if (part.dynamic === true || part.providerExecuted === true) {
      handle.span.addEvent(`harness.${type || "dynamic"}`, {
        "harness.part.type": type,
      });
    }
  };

  async function* wrapped(): AsyncGenerator<HarnessStreamPart> {
    // The turn span is finished EAGERLY by the wrapper from the resolved result
    // BEFORE this generator is ever iterated (so a dropped/never-iterated stream
    // can't leak it open). This generator only synthesizes + ends CHILD spans;
    // its `finally` runs on every terminal path it CAN reach (full drain, early
    // `return()`/break, mid-iteration throw) and closes those children, clamped
    // to the parent endTime so child.endTime <= parent.endTime always holds.
    const iterator = (stream as AsyncIterable<HarnessStreamPart>)[
      Symbol.asyncIterator
    ]();
    // Whether to synthesize children for the part currently being handled.
    // RE-READ PER PART (not snapshot once): Core telemetry can flip this turn's
    // dedupe signal AFTER an earlier part — e.g. a harness that emits a
    // lifecycle/text part to the user BEFORE its first Core `onStart` microtask
    // runs, or a later step that routes through Core mid-stream. The wrapper's
    // closure reads `coreTelemetryFired`, which is MONOTONIC (false→true), so
    // `shouldSynthesize()` only ever goes true→false; re-reading it each
    // iteration latches synthesis OFF the moment Core covers the turn and stops
    // doubling children alongside the real v7 spans. Tracks the latest value so
    // the `finally` can fall back to it for a zero-part stream.
    let synthesize: boolean | undefined;
    // Captures an in-flight iteration error so the finally can record it on the
    // turn span as evidence (issue #2) before it re-throws to the user.
    let streamError: unknown;
    try {
      while (true) {
        // PAUSE the idle-fallback while we await the producer's next part, so a
        // slow producer (parts across macrotasks) can't let the fallback end the
        // turn span mid-drain and drop the mid-iteration `stream.error` /
        // dynamic-marker events recorded on the live span. Each next() runs in
        // its own context frame so nested Laminar instrumentation sees the turn
        // context across yields (per CLAUDE.md).
        handle.pauseFallbackEnd();
        const stack = LaminarContextManager.getContextStack();
        // Pull the next part inside BOTH the isolated Laminar context frame
        // (nested instrumentation sees the turn context — per CLAUDE.md) AND the
        // turn-signal frame, so Core telemetry fired by the producer DURING
        // `next()` flips THIS turn's dedupe flag (the wrapper's frame has already
        // unwound by now). `synthesize` is then re-read below off that flag.
        const { value, done } =
          await runWithTurnSignal(turnSignal, () =>
            LaminarContextManager.runWithIsolatedContext(
              [...stack, handle.ctx],
              () => iterator.next(),
            ),
          );
        if (done) break;
        // Re-read each part so a Core dispatch that flips the dedupe signal
        // mid-stream stops further synthesis (monotonic true→false).
        synthesize = shouldSynthesize();
        handlePart(value, synthesize);
        // RE-ARM the idle-fallback before handing control to the user: if they
        // receive this part and then ABANDON the iterator (never drain /
        // `return()`), the fallback fires on the next idle macrotask and commits
        // the deferred end instead of leaking. A prompt loop re-enters and pauses
        // it again within microtasks, before the `setTimeout(0)` can fire.
        handle.armFallbackEnd();
        yield value;
      }
    } catch (err) {
      streamError = err;
      throw err;
    } finally {
      // Close any child spans we synthesized, clamped to the (already-finished)
      // parent endTime. Even an early `return()` from the consumer (break out of
      // their for-await) and a mid-iteration throw reach here. We do NOT FLIP
      // the turn span's status here: it was finished by the wrapper's eager
      // `finishFromResult` (normal) or by an `abort()` / `error()` (which also
      // sets `handle.isFinished()`, making `finishSynthesizedSpans` a no-op so
      // no child is emitted outside the parent window — issue #2). The turn's
      // outcome was already settled from the harness result that produced this
      // stream, so an OK turn stays OK.
      //
      // But a mid-iteration stream error (which re-throws to the user unchanged)
      // must still leave EVIDENCE so the failed consumption is visible in
      // Laminar. We record it on the turn span as both an exception
      // (`recordException`) and a dedicated `stream.error` event — WITHOUT
      // touching the turn status. Guarded by the addEvent/recordException APIs
      // being present (defensive against a non-recording / minimal span).
      if (streamError !== undefined) {
        const message = errorMessage(streamError);
        if (typeof handle.span.recordException === "function") {
          handle.span.recordException(
            streamError instanceof Error ? streamError : new Error(message),
          );
        }
        handle.span.addEvent("stream.error", {
          "harness.stream.error": message,
        });
      }
      finishSynthesizedSpans(synthesize ?? shouldSynthesize());
      // Commit the deferred physical end of the turn span. The turn DATA was
      // settled eagerly by the wrapper's `finishFromResult`; we deferred the
      // physical `span.end()` so the `stream.error` event above could land on a
      // LIVE span. Now that children are closed and any error evidence recorded,
      // end the span (no-op if the macrotask fallback or an abort/error already
      // ended it).
      handle.finishTurnSpan();
    }
  }

  // Wrap the generator so ACQUIRING the iterator (`for await` start, or an
  // explicit `stream[Symbol.asyncIterator]()`) SYNCHRONOUSLY pauses the idle-
  // fallback BEFORE the first `next()`. Without this, a consumer that takes the
  // stream and then awaits ≥1 macrotask before its first `next()` leaves the
  // pre-first-iteration window uncovered: the fallback armed eagerly by
  // `finishFromResult` fires during that gap and physically ends the turn span,
  // so the consumer's later `stream.error` / `recordException` / `harness.*`
  // marker events (recorded on the LIVE span during the deferred drain) are
  // dropped by OTel (cursor[bot] "Fallback ends span before drain"). The
  // generator's own loop re-pauses on each `next()` and re-arms before each
  // `yield`, so a consumer that abandons after acquiring still gets the span
  // committed by the re-armed fallback rather than leaking. A never-acquired
  // stream never hits this method, so the eager fallback still commits it (no
  // leak). The underlying generator returns itself from its `[Symbol.asyncIterator]`,
  // so re-acquiring is idempotent.
  const gen = wrapped();
  const stream$: AsyncIterable<HarnessStreamPart> = {
    [Symbol.asyncIterator]() {
      handle.pauseFallbackEnd();
      return gen[Symbol.asyncIterator]();
    },
  };
  return { consumed: true, stream: stream$ };
};
