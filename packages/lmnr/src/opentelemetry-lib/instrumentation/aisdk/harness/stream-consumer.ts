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
  // turn. Evaluated lazily on the first stream part.
  shouldSynthesize: () => boolean,
): ConsumeHarnessStreamResult => {
  if (!isAsyncIterable(stream)) return { consumed: false };

  const synth: SynthState = { text: "", reasoning: "", toolCalls: [] };
  // TOOL spans, keyed by toolCallId, opened on tool-call and closed on the
  // matching tool-result. Provider-executed / dynamic tool parts also land here.
  const toolSpans = new Map<string, Span>();

  // CLAMP MODEL. The wrapper finishes the parent turn span EAGERLY from the
  // resolved result, possibly BEFORE this generator iterates (iteration may be
  // deferred). The invariant we must keep is child.endTime <= parent.endTime,
  // WITHOUT needlessly destroying real per-LLM / per-tool timing.
  //
  // Two cases, decided per child by comparing its REAL start to the parent end:
  //
  // - Normal / prompt-drain case (realStart <= parentEnd): use the child's REAL
  //   start and REAL end. For a promptly-drained stream the child also ends
  //   before the parent (realEnd <= parentEnd), so the general clamp
  //   end = min(realEnd, parentEnd) is a no-op and TRUE duration survives. If a
  //   tail somehow ran past parentEnd we clamp only the end down to parentEnd —
  //   start stays real (still <= end), so the invariant holds with minimal loss.
  //
  // - Deferred case (realStart > parentEnd): a child cannot start after its
  //   parent ended without the OTel SDK rejecting the backdated start (it falls
  //   back to now()), so we PIN both start and end to parentEnd — a
  //   zero-duration child exactly at the parent end. This degradation is now
  //   confined to the genuinely-after-parent case instead of every child.
  //
  // When parentEnd isn't known (parent not finished — shouldn't happen on the
  // eager path, but defensive) we fall back to live timestamps (no clamp).
  //
  // Start options for a synthesized child. Use the real start unless it would
  // fall AFTER the parent end (deferred case) — then pin the start to parentEnd
  // so the SDK accepts it and the child collapses to zero duration there.
  const childStartOpts = (kind: SpanKind) => {
    const parentEnd = handle.parentEndTime();
    if (parentEnd === undefined) return { kind };
    const realStartNanos = hrTimeToNanoseconds(hrTime());
    if (realStartNanos > hrTimeToNanoseconds(parentEnd)) {
      // Deferred: real start is after the parent already ended — pin it.
      return { kind, startTime: parentEnd };
    }
    // Normal: let the SDK stamp the real start (now).
    return { kind };
  };

  // End a synthesized child at min(realEnd, parentEnd) so the child never
  // outlives the parent, while a promptly-drained child keeps its real end (and
  // thus its real duration). Falls back to the live end when parentEnd is
  // unknown.
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
    // Close any still-open TOOL spans (provider never emitted a result part),
    // clamped to the (already-finished) parent endTime.
    for (const span of toolSpans.values()) {
      span.setStatus({ code: SpanStatusCode.OK });
      endChild(span);
    }
    toolSpans.clear();
    // When deduping (Core telemetry covered this turn) we must NOT emit a
    // synthesized LLM span — the v7 integration already produced the real one,
    // and the turn-span output already carries the assistant text.
    if (!synthesize) return;
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
    // Once the turn was closed by an abort/error, do NOT open new child spans —
    // they would outlive the already-ended parent (issue #2). Text is still
    // accumulated above (harmless; the turn output was already set from result).
    if (!synthesize || handle.isFinished()) return;
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
    // Dynamic provider-executed parts (compaction, workspace file changes, ...)
    // — record as a marker event on the turn span so they're visible without
    // forcing a full TOOL span when we don't have a call/result pair.
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
        const { value, done } =
          await LaminarContextManager.runWithIsolatedContext(
            [...stack, handle.ctx],
            () => iterator.next(),
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

  return { consumed: true, stream: wrapped() };
};
