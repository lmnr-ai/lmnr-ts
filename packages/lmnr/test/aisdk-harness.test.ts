import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  getActiveTurnSignal,
  markCoreTelemetryFired,
  type TurnSignal,
} from "../src/opentelemetry-lib/instrumentation/aisdk/harness/core-telemetry-signal";
import {
  harnessTelemetry,
  instrumentHarnessAgent,
} from "../src/opentelemetry-lib/instrumentation/aisdk/harness/index";
import type {
  HarnessGenerateOptionsLike,
} from "../src/opentelemetry-lib/instrumentation/aisdk/harness/types";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
} from "../src/opentelemetry-lib/tracing/attributes";

// Synthetic harness result / stream — no `ai` or `@ai-sdk/harness-*` runtime
// dependency, mirroring the synthetic-event style of aisdk-v7-telemetry.test.ts.

interface StreamPart {
  type: string;
  [k: string]: unknown;
}

// An async-iterable that yields the given parts once (single-consumption).
const mkStream = (parts: StreamPart[]): AsyncIterable<StreamPart> => ({
  async *[Symbol.asyncIterator]() {
    for (const p of parts) {
      await Promise.resolve();
      yield p;
    }
  },
});

// A minimal fake HarnessAgent. `generate` resolves a result; `stream` resolves
// a result carrying a stream of parts.
interface TestAgent {
  harness: unknown;
  generate: (options: HarnessGenerateOptionsLike) => unknown;
  stream: (options: HarnessGenerateOptionsLike) => unknown;
  createSession: () => unknown;
  [k: string]: unknown;
}

const mkAgent = (opts: {
  harness?: unknown;
  generateResult?: Record<string, unknown>;
  streamResult?: Record<string, unknown>;
  generateThrows?: Error;
  // Simulate the harness routing through Core generateText/streamText: the v7
  // integration's onStart (which calls markCoreTelemetryFired) fires WHILE the
  // wrapped stream() runs — i.e. inside the turn's context/signal frame.
  streamFiresCoreTelemetry?: boolean;
  // Capture this turn's dedupe signal from inside stream() (it is the ALS frame
  // the v7 onStart would flip). Lets a test fire Core telemetry LATE — after the
  // first stream part — to exercise the per-part re-read of `shouldSynthesize`.
  captureTurnSignal?: (signal: TurnSignal | undefined) => void;
}): TestAgent => ({
  harness: opts.harness ?? "claude-code",
  generate: () => {
    if (opts.generateThrows !== undefined) {
      return Promise.reject(opts.generateThrows);
    }
    return Promise.resolve(opts.generateResult ?? { text: "done" });
  },
  stream: () => {
    if (opts.streamFiresCoreTelemetry) markCoreTelemetryFired();
    opts.captureTurnSignal?.(getActiveTurnSignal());
    return Promise.resolve(opts.streamResult ?? {});
  },
  createSession: () => ({ id: "sess-1" }),
});

const drain = async (stream: unknown): Promise<StreamPart[]> => {
  const out: StreamPart[] = [];
  for await (const p of stream as AsyncIterable<StreamPart>) {
    out.push(p);
  }
  return out;
};

const toHr = (t: [number, number]) => t[0] * 1e9 + t[1];

void describe("AI SDK harness instrumentation", () => {
  let exporter: InMemorySpanExporter;

  void beforeEach(() => {
    _resetConfiguration();
    exporter = new InMemorySpanExporter();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(async () => {
    await exporter.shutdown();
  });

  void after(() => {
    trace.disable();
    context.disable();
  });

  void it("opens a DEFAULT turn span with input/output/usage for generate", async () => {
    const agent = instrumentHarnessAgent(
      mkAgent({
        harness: "claude-code",
        generateResult: {
          text: "the answer is 42",
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
          finishReason: "stop",
        },
      }),
    );

    const result = await agent.generate({
      session: { id: "sess-abc" },
      prompt: "what is the answer?",
    });
    assert.equal((result as { text: string }).text, "the answer is 42");

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.generate");
    assert.ok(turn, "turn span missing");
    assert.equal(turn.attributes[SPAN_TYPE], "DEFAULT");
    assert.equal(turn.attributes["harness.harness"], "claude-code");
    assert.equal(turn.attributes["harness.session.id"], "sess-abc");
    // Input: prompt string normalized to a user message array.
    const input = JSON.parse(turn.attributes[SPAN_INPUT] as string);
    assert.equal(input[0].role, "user");
    assert.equal(turn.attributes[SPAN_OUTPUT], "the answer is 42");
    assert.equal(turn.attributes["gen_ai.usage.input_tokens"], 12);
    assert.equal(turn.attributes["gen_ai.usage.output_tokens"], 7);
    assert.equal(turn.attributes["ai.response.finishReason"], "stop");
  });

  void it("falls back SPAN_OUTPUT to serialized responseMessages when no text", async () => {
    const agent = instrumentHarnessAgent(
      mkAgent({
        generateResult: {
          responseMessages: [{ role: "assistant", content: "hi" }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      }),
    );
    await agent.generate({ prompt: "hi" });
    const turn = exporter
      .getFinishedSpans()
      .find((s) => s.name === "harness.generate");
    assert.ok(turn);
    const out = turn.attributes[SPAN_OUTPUT];
    assert.ok(typeof out === "string" && out.includes("assistant"));
  });

  void it("synthesizes LLM + TOOL children from stream parts (no core telemetry)", async () => {
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final",
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          stream: mkStream([
            { type: "reasoning-delta", text: "thinking..." },
            { type: "text-delta", text: "Let me " },
            { type: "text-delta", text: "look it up." },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "search",
              input: { q: "weather" },
            },
            {
              type: "tool-result",
              toolCallId: "tc-1",
              output: { weather: "sunny" },
            },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "weather?" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // The user can still consume the stream.
    const parts = await drain(result.stream);
    assert.equal(parts.length, 5);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span missing");
    assert.equal(turn.attributes[SPAN_TYPE], "DEFAULT");

    const llm = spans.find((s) => s.name === "harness.llm");
    assert.ok(llm, "synthesized llm span missing");
    assert.equal(llm.attributes[SPAN_TYPE], "LLM");
    // LLM output is gen_ai.output.messages ONLY (replay parity).
    assert.ok(llm.attributes["gen_ai.output.messages"]);
    assert.equal(llm.attributes[SPAN_OUTPUT], undefined);
    const outMsgs = JSON.parse(
      llm.attributes["gen_ai.output.messages"] as string,
    );
    assert.equal(outMsgs[0].role, "assistant");
    assert.equal(outMsgs[0].parts[0].type, "thinking");
    assert.equal(outMsgs[0].parts[1].type, "text");
    assert.equal(outMsgs[0].parts[1].content, "Let me look it up.");
    assert.equal(outMsgs[0].parts[2].type, "tool_call");

    const tool = spans.find((s) => s.name === "harness.tool search");
    assert.ok(tool, "synthesized tool span missing");
    assert.equal(tool.attributes[SPAN_TYPE], "TOOL");
    assert.equal(tool.attributes["ai.toolCall.id"], "tc-1");

    // Children end before/at the parent turn span.
    const turnEnd = toHr(turn.endTime);
    assert.ok(toHr(llm.endTime) <= turnEnd, "llm ended after turn");
    assert.ok(toHr(tool.endTime) <= turnEnd, "tool ended after turn");
  });

  void it("synthesized children keep REAL duration on a normal immediate drain", async () => {
    // cursor[bot] "Synthesized children always zero duration": the turn span is
    // finished EAGERLY (data-settle) when stream() resolves, but its PHYSICAL
    // end is deferred. If the child clamp keyed off the eager snapshot, every
    // normally-drained child (whose realStart is always after that snapshot)
    // would be pinned to zero duration. The clamp must engage only once the span
    // is PHYSICALLY ended — so an immediately-drained TOOL span that spans a real
    // wall-clock gap keeps its true (non-zero) duration.
    const slowStream: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", text: "hi" };
        yield {
          type: "tool-call",
          toolCallId: "tc-dur",
          toolName: "search",
          input: { q: "x" },
        };
        // A real macrotask gap so the TOOL span (opened on tool-call, closed on
        // tool-result) covers measurable wall-clock time.
        await new Promise((r) => setTimeout(r, 10));
        yield { type: "tool-result", toolCallId: "tc-dur", output: { ok: true } };
      },
    };
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: { text: "final", stream: slowStream },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await drain(result.stream);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    const tool = spans.find((s) => s.name === "harness.tool search");
    assert.ok(turn, "turn span missing");
    assert.ok(tool, "synthesized tool span missing");
    // The TOOL span must carry its REAL duration (>= the ~10ms gap), NOT a
    // zero-duration pin to the eager parent-end snapshot.
    const toolDuration = toHr(tool.endTime) - toHr(tool.startTime);
    assert.ok(
      toolDuration > 0,
      `tool span has zero duration (pinned to eager snapshot): ${toolDuration}ns`,
    );
    // Invariant still holds: child ends at-or-before the (physically-ended) turn.
    assert.ok(
      toHr(tool.endTime) <= toHr(turn.endTime),
      "tool ended after turn (clamp invariant broken)",
    );
  });

  void it("dedupes: no synthesized children when core telemetry fired", async () => {
    const agent = instrumentHarnessAgent(
      mkAgent({
        // The harness routes through Core: markCoreTelemetryFired() fires inside
        // the wrapped stream() call (the turn's context/signal frame).
        streamFiresCoreTelemetry: true,
        streamResult: {
          text: "final",
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            {
              type: "tool-call",
              toolCallId: "tc-x",
              toolName: "search",
              input: {},
            },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await drain(result.stream);

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.find((s) => s.name === "harness.stream"));
    // No synthesized LLM / TOOL children — Core telemetry covered the turn.
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "should not synthesize an LLM span when core telemetry fired",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "should not synthesize a TOOL span when core telemetry fired",
    );
  });

  void it("records dynamic harness markers even when deduping", async () => {
    // cursor[bot] "Dedupe skips dynamic harness events": when Core telemetry
    // covers the turn, synthesized LLM/TOOL CHILD spans are suppressed — but the
    // dynamic/providerExecuted lifecycle MARKERS are turn-span events, not child
    // spans, and the v7 integration never produces them, so they must still be
    // recorded as `harness.<type>` events on the turn span.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamFiresCoreTelemetry: true,
        streamResult: {
          text: "final",
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            { type: "compaction", dynamic: true },
            {
              type: "tool-call",
              toolCallId: "tc-x",
              toolName: "search",
              input: {},
            },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await drain(result.stream);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span missing");
    // The dynamic marker is recorded on the turn span despite deduping.
    const marker = turn.events.find((e) => e.name === "harness.compaction");
    assert.ok(
      marker,
      "dynamic harness marker must be recorded on the turn span even when deduping",
    );
    assert.equal(marker.attributes?.["harness.part.type"], "compaction");
    // No synthesized children — Core telemetry covered the turn.
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "should not synthesize an LLM span when core telemetry fired",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "should not synthesize a TOOL span when core telemetry fired",
    );
  });

  void it("dedupes when core telemetry fires LATE (after the first part)", async () => {
    // cursor[bot] "Core dedupe only first part": some harnesses emit a
    // lifecycle/text part to the user BEFORE their first Core `onStart` runs (or
    // route a later step through Core mid-stream). `shouldSynthesize()` must be
    // re-read PER PART, not snapshot once — otherwise the consumer keeps
    // synthesizing duplicate children after Core covered the turn. We capture
    // this turn's dedupe signal in stream() and flip it AFTER the first part.
    let turnSignal: TurnSignal | undefined;
    const agent = instrumentHarnessAgent(
      mkAgent({
        captureTurnSignal: (s) => {
          turnSignal = s;
        },
        streamResult: {
          text: "final",
          stream: mkStream([
            // First part: pure text — synthesize is still true here.
            { type: "text-delta", text: "hi" },
            // Core fires LATE (flipped between parts below) — this tool-call and
            // the LLM span at finish must NOT be synthesized.
            {
              type: "tool-call",
              toolCallId: "tc-late",
              toolName: "search",
              input: {},
            },
            { type: "tool-result", toolCallId: "tc-late", output: { ok: true } },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    const it = result.stream[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal((first.value as StreamPart).type, "text-delta");
    // Core telemetry fires NOW — after the first part was already handled.
    assert.ok(turnSignal, "turn signal should have been captured in stream()");
    turnSignal.coreTelemetryFired = true;
    // Drain the rest: the tool-call + tool-result arrive after the flip.
    while (!(await it.next()).done) {
      // consume
    }

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.find((s) => s.name === "harness.stream"));
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "must stop synthesizing TOOL children once Core telemetry fires mid-stream",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "must not synthesize the LLM span once Core telemetry fired mid-stream",
    );
  });

  void it("dedupes when core telemetry fires DURING part production (next())", async () => {
    // cursor[bot] "Core dedupe missing during stream": the turn-signal ALS frame
    // the wrapper opens around the harness call has UNWOUND by the time the user
    // iterates result.stream. A harness that routes a step through Core WHILE
    // producing a part calls markCoreTelemetryFired() during iterator.next() — if
    // the consumer doesn't re-establish runWithTurnSignal around next(), that
    // call is a no-op (no active store) and the flag never flips, so synthesized
    // children duplicate the v7 spans. This stream fires it from inside its OWN
    // generator body (which runs during next()), NOT by flipping a captured
    // signal, so it only passes when the consumer wraps next() in the signal.
    const stream: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { type: "text-delta", text: "hi" };
        // Core telemetry fires WHILE producing the next part (inside next()).
        markCoreTelemetryFired();
        await Promise.resolve();
        yield {
          type: "tool-call",
          toolCallId: "tc-during",
          toolName: "search",
          input: {},
        };
        await Promise.resolve();
        yield { type: "tool-result", toolCallId: "tc-during", output: { ok: true } };
      },
    };
    const agent = instrumentHarnessAgent(
      mkAgent({ streamResult: { text: "final", stream } }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await drain(result.stream);

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.find((s) => s.name === "harness.stream"));
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "Core telemetry fired during next() must flip the dedupe flag (no TOOL child)",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "Core telemetry fired during next() must flip the dedupe flag (no LLM child)",
    );
  });

  void it("closes turn + open children on error (child.endTime <= parent.endTime)", async () => {
    const agent = instrumentHarnessAgent(
      mkAgent({ generateThrows: new Error("boom") }),
    );
    await assert.rejects(
      () => agent.generate({ prompt: "x" }) as Promise<unknown>,
    );

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.generate");
    assert.ok(turn);
    assert.equal(turn.status.code, 2); // SpanStatusCode.ERROR
    assert.equal(turn.status.message, "boom");
  });

  void it("re-throws a mid-iteration stream error, force-closing the open child", async () => {
    // Round-3 model: the harness call resolved successfully and produced the
    // stream, so the turn span is finished eagerly OK. A stream that then throws
    // mid-iteration re-throws to the user unchanged; the open child span we had
    // synthesized is force-closed in the generator's finally, clamped to the
    // (already-finished) parent endTime so child.endTime <= parent.endTime.
    const errStream: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield {
          type: "tool-call",
          toolCallId: "tc-err",
          toolName: "broken",
          input: {},
        };
        throw new Error("stream blew up");
      },
    };
    const agent = instrumentHarnessAgent(
      mkAgent({ streamResult: { text: "partial", stream: errStream } }),
    );
    const result = (await agent.stream({ prompt: "x" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // The error must still surface to the user draining the stream.
    await assert.rejects(() => drain(result.stream), /stream blew up/);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    const tool = spans.find((s) => s.name === "harness.tool broken");
    assert.ok(turn, "turn span should be finished (eagerly from the result)");
    assert.ok(tool, "open tool span should be force-closed in the finally");
    // Turn outcome was settled from the harness result (OK) before the stream
    // threw — the user-side replay error does not retroactively fail the turn.
    assert.equal(turn.status.code, 1); // SpanStatusCode.OK
    assert.ok(
      toHr(tool.endTime) <= toHr(turn.endTime),
      "tool span ended after the turn span (clamp broken)",
    );
    // Round-4 evidence: the mid-iteration error is recorded on the turn span as
    // a `stream.error` event + exception WITHOUT flipping its OK status. The
    // event must land BEFORE the deferred physical end (OTel drops events after
    // end()) — proving the deferred-end design works.
    const streamErrEvent = turn.events.find((e) => e.name === "stream.error");
    assert.ok(streamErrEvent, "stream.error event missing on the turn span");
    assert.equal(
      streamErrEvent.attributes?.["harness.stream.error"],
      "stream blew up",
    );
    assert.ok(
      turn.events.some((e) => e.name === "exception"),
      "recordException did not add an exception event",
    );
  });

  void it("records stream.error on the LIVE span for a multi-macrotask stream", async () => {
    // Eve round 4: the deferred physical end exists so the consumer's finally can
    // record a mid-iteration `stream.error` event on the LIVE turn span. A fixed
    // `setTimeout(0)` never-iterated fallback would WIN the race against a real
    // I/O-bound stream whose parts arrive across separate macrotasks — ending the
    // span mid-drain and dropping the event. The consumer disarms the fallback on
    // engage, so this stream (macrotask gaps via setTimeout) must still record the
    // event on the live span.
    const macrotaskErrStream: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => setTimeout(r, 0));
        yield { type: "text-delta", text: "partial" };
        await new Promise((r) => setTimeout(r, 0));
        yield {
          type: "tool-call",
          toolCallId: "tc-mm",
          toolName: "slow",
          input: {},
        };
        await new Promise((r) => setTimeout(r, 0));
        throw new Error("late stream failure");
      },
    };
    const agent = instrumentHarnessAgent(
      mkAgent({ streamResult: { text: "ok", stream: macrotaskErrStream } }),
    );
    const result = (await agent.stream({ prompt: "x" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await assert.rejects(() => drain(result.stream), /late stream failure/);

    const turn = exporter
      .getFinishedSpans()
      .find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span missing");
    // The event landed on the live span despite the multi-macrotask drain.
    const ev = turn.events.find((e) => e.name === "stream.error");
    assert.ok(
      ev,
      "stream.error event dropped — fallback ended the span mid-drain",
    );
    assert.equal(ev.attributes?.["harness.stream.error"], "late stream failure");
    // Turn outcome was settled OK from the result before the late failure.
    assert.equal(turn.status.code, 1); // OK
  });

  void it("ends the turn span no earlier than events recorded during a slow drain", async () => {
    // cursor[bot] "Turn span end backdated past events": finishFromResult
    // snapshots turnEndTime when the harness call RESOLVES, but the consumer's
    // finally records `stream.error` / exception (and handlePart records
    // `harness.*` markers) on the LIVE span at real now() DURING a slow,
    // multi-macrotask drain — AFTER that snapshot. The deferred commit must end
    // the span at the LATER of the snapshot and now, or those events fall outside
    // [startTime, endTime] and strict backends drop/flag them. Assert every event
    // recorded on the turn span lands within the span window.
    const slowErrStream: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "text-delta", text: "partial" };
        await new Promise((r) => setTimeout(r, 5));
        // A dynamic provider-executed marker — recorded as a `harness.*` event on
        // the live span during iteration (after the eager turnEndTime snapshot).
        yield { type: "compaction", dynamic: true };
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("delayed failure");
      },
    };
    const agent = instrumentHarnessAgent(
      mkAgent({ streamResult: { text: "ok", stream: slowErrStream } }),
    );
    const result = (await agent.stream({ prompt: "x" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    await assert.rejects(() => drain(result.stream), /delayed failure/);

    const turn = exporter
      .getFinishedSpans()
      .find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span missing");
    assert.ok(turn.events.length > 0, "no events recorded on the turn span");
    const turnStart = toHr(turn.startTime);
    const turnEnd = toHr(turn.endTime);
    // Every event (stream.error, exception, harness.compaction marker) must fall
    // WITHIN the span window — the fix ends the span at max(snapshot, now).
    for (const e of turn.events) {
      const t = toHr(e.time);
      assert.ok(
        t >= turnStart && t <= turnEnd,
        `event ${e.name} at ${t} fell outside the turn span [${turnStart}, ${turnEnd}]`,
      );
    }
    // The marker event was recorded (proves a `harness.*` event landed late).
    assert.ok(
      turn.events.some((e) => e.name.startsWith("harness.")),
      "expected a harness.* marker event on the turn span",
    );
  });

  void it("finishes the turn span from an absent/non-iterable stream (no leak)", async () => {
    // No async-iterable stream: consumeHarnessStream returns consumed:false, so
    // the wrapper finishes the turn eagerly from the result. There is no
    // generator to engage, no synthesized children, so the clamp can't be
    // violated and nothing leaks.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final answer",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      }),
    );

    await agent.stream({ prompt: "go" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span leaked: never finished without an iterable stream");
    assert.equal(turn.attributes[SPAN_OUTPUT], "final answer");
    assert.equal(turn.status.code, 1); // OK
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
    );
  });

  void it("finishes the turn span when a PRESENT stream is NEVER consumed (no leak)", async () => {
    // Round-3 fix #1: a caller takes result.stream and NEVER iterates it. The
    // wrapped generator's finally never runs (a generator finally only runs on
    // iterate / return() / GC), so it cannot be the sole finisher. The wrapper
    // finishes the turn span EAGERLY from the resolved result, so the span is
    // closed (with output/usage) regardless of whether the stream is ever
    // touched — proving no leak.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final answer",
          usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          finishReason: "stop",
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            {
              type: "tool-call",
              toolCallId: "tc-never",
              toolName: "search",
              input: {},
            },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // Deliberately never touch result.stream. Let any pending macrotasks flush.
    assert.ok(result.stream, "wrapped stream should still be returned");
    await new Promise((r) => setTimeout(r, 0));

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span leaked: never finished for an un-consumed stream");
    // Output / usage come from the resolved result (the eager finalize).
    assert.equal(turn.attributes[SPAN_OUTPUT], "final answer");
    assert.equal(turn.attributes["gen_ai.usage.input_tokens"], 9);
    assert.equal(turn.attributes["gen_ai.usage.output_tokens"], 4);
    assert.equal(turn.attributes["ai.response.finishReason"], "stop");
    assert.equal(turn.status.code, 1); // OK
    // No children: synthesis only happens through iteration, which never ran.
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "no LLM child should be synthesized for an un-iterated stream",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "no TOOL child should be synthesized for an un-iterated stream",
    );
  });

  void it("finishes the turn span when a stream is partially consumed then abandoned", async () => {
    // Eve round 5: a caller drives the iterator MANUALLY, pulls one part, then
    // drops the iterator WITHOUT draining or calling return() — so the wrapped
    // generator's `finally` never runs (only full drain / return() / throw runs
    // it). The idle-fallback is paused during the `next()` we await but RE-ARMED
    // before the part is yielded, so once the caller goes idle it fires on the
    // next macrotask and commits the deferred end — no leak.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final answer",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            { type: "text-delta", text: " there" },
            { type: "text-delta", text: " more" },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // Manually pull exactly one part, then abandon the iterator.
    const it = result.stream[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal((first.value as StreamPart).type, "text-delta");
    // Drop `it` here — never call it.next() again, never it.return(). Let the
    // re-armed idle-fallback fire.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(
      turn,
      "turn span leaked: partially-consumed-then-abandoned stream never committed",
    );
    assert.equal(turn.attributes[SPAN_OUTPUT], "final answer");
    assert.equal(turn.status.code, 1); // OK
  });

  void it("closes open TOOL children when a stream is abandoned mid-tool-call", async () => {
    // cursor[bot] "Abandoned stream leaves open tools": a caller pulls the
    // `tool-call` part (which opens a `harness.tool` child) then DROPS the
    // iterator without draining / return() — so the wrapped generator's `finally`
    // (which runs `finishSynthesizedSpans` to close tool spans) never runs. The
    // turn span is committed by the re-armed idle-fallback, which MUST also close
    // the still-open child clamped to the parent end so it is exported (not
    // leaked) with child.endTime <= parent.endTime.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final answer",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          stream: mkStream([
            {
              type: "tool-call",
              toolCallId: "tc-abandon",
              toolName: "search",
              input: { q: "x" },
            },
            { type: "tool-result", toolCallId: "tc-abandon", output: { ok: true } },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // Pull exactly the tool-call part (opens the TOOL child), then abandon.
    const it = result.stream[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal((first.value as StreamPart).type, "tool-call");
    // Drop `it` — never pull the tool-result, never return(). Let the re-armed
    // idle-fallback commit the turn end and close the open child.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span leaked: abandoned-mid-tool-call stream never committed");
    const tool = spans.find((s) => s.name === "harness.tool search");
    assert.ok(
      tool,
      "TOOL child leaked: abandoned stream never closed the open harness.tool span",
    );
    assert.ok(
      toHr(tool.endTime) <= toHr(turn.endTime),
      "TOOL child must end at-or-before the turn span",
    );
  });

  void it("clamps children synthesized by DEFERRED iteration to the eager parent end", async () => {
    // Round-3 model: the turn span is finished EAGERLY from the resolved result
    // when stream() resolves — so a dropped/never-iterated stream cannot leak
    // (see the never-consumed test below). The caller here defers iteration past
    // its own macrotask (simulates `await someSetup()` / storing the stream to
    // drain later). Because the parent is already finished, children synthesized
    // by the later iteration MUST be clamped to the parent endTime so
    // child.endTime <= parent.endTime still holds despite the deferral.
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final",
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            {
              type: "tool-call",
              toolCallId: "tc-d",
              toolName: "search",
              input: { q: "x" },
            },
            { type: "tool-result", toolCallId: "tc-d", output: { ok: true } },
          ]),
        },
      }),
    );

    const result = (await agent.stream({ prompt: "go" })) as {
      stream: AsyncIterable<StreamPart>;
    };
    // Defer iteration past the current macrotask. The turn span is ALREADY
    // finished eagerly here (the leak-proof guarantee) — assert it.
    await new Promise((r) => setTimeout(r, 0));
    const turnEager = exporter
      .getFinishedSpans()
      .find((s) => s.name === "harness.stream");
    assert.ok(
      turnEager,
      "turn span should be finished eagerly before deferred drain (no leak)",
    );
    assert.equal(turnEager.status.code, 1); // OK
    assert.equal(turnEager.attributes[SPAN_OUTPUT], "final");
    // No children synthesized yet — the deferred iteration hasn't run.
    assert.equal(
      exporter.getFinishedSpans().find((s) => s.name === "harness.llm"),
      undefined,
      "children synthesized before the deferred iteration ran",
    );

    const parts = await drain(result.stream);
    assert.equal(parts.length, 3);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn);

    // Children are synthesized by the deferred iteration and MUST still end
    // before/at the (eagerly-finished) parent turn span (clamp holds).
    const llm = spans.find((s) => s.name === "harness.llm");
    const tool = spans.find((s) => s.name === "harness.tool search");
    assert.ok(llm, "synthesized llm span missing after deferred drain");
    assert.ok(tool, "synthesized tool span missing after deferred drain");
    const turnEnd = toHr(turn.endTime);
    assert.ok(toHr(llm.endTime) <= turnEnd, "llm ended after turn (clamp broken)");
    assert.ok(toHr(tool.endTime) <= turnEnd, "tool ended after turn (clamp broken)");
  });

  void it("ends the turn span as aborted when the AbortSignal wins the eager finish", async () => {
    // Abort fires BEFORE the eager finalize: the signal is already aborted when
    // the turn span opens, so openHarnessTurnSpan calls abort() synchronously
    // during stream(), before the result promise resolves. abort() therefore
    // wins the `finished` guard and the trailing eager finishFromResult no-ops —
    // the turn is recorded as a deliberate cancellation, not OK.
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "partial",
          stream: mkStream([{ type: "text-delta", text: "hi" }]),
        },
      }),
    );

    await agent.stream({ prompt: "go", abortSignal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span should be ended on abort");
    // Abort is a deliberate cancellation — UNSET status (0), abort marker set.
    assert.equal(turn.status.code, 0); // UNSET
    assert.equal(turn.attributes["harness.aborted"], true);
    assert.equal(turn.attributes["harness.abortReason"], "user cancelled");
    assert.ok(turn.events.some((e) => e.name === "abort"));
  });

  void it("skips child synthesis when the turn was already aborted, THEN drained", async () => {
    // Round-3 fix #2 (abort-then-drain clamp violation). The AbortSignal fires
    // and finishes the turn via abort() BEFORE the caller drains the still-
    // returned wrapped stream. The consumer must SKIP creating/closing child
    // LLM/TOOL spans on that late drain — otherwise it would emit children whose
    // endTime is later than the already-ended parent (clamp violation) and leave
    // orphan children outside the parent window.
    const controller = new AbortController();
    // Pre-aborted so abort() runs synchronously inside stream(), before the
    // result resolves — abort wins the `finished` guard.
    controller.abort(new Error("cancelled"));
    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "partial",
          stream: mkStream([
            { type: "text-delta", text: "hi" },
            {
              type: "tool-call",
              toolCallId: "tc-abort",
              toolName: "search",
              input: { q: "x" },
            },
            { type: "tool-result", toolCallId: "tc-abort", output: { ok: 1 } },
          ]),
        },
      }),
    );

    const result = (await agent.stream({
      prompt: "go",
      abortSignal: controller.signal,
    })) as { stream: AsyncIterable<StreamPart> };
    // Drain the still-returned wrapped stream AFTER the abort already finished
    // the turn.
    const parts = await drain(result.stream);
    // The user still gets the parts (re-yield is unaffected).
    assert.equal(parts.length, 3);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span should be the aborted one");
    assert.equal(turn.status.code, 0); // UNSET (aborted)
    const turnEnd = toHr(turn.endTime);
    // No child spans created post-abort — clamp can't be violated by absent
    // children.
    assert.equal(
      spans.find((s) => s.name === "harness.llm"),
      undefined,
      "no LLM child should be synthesized after an aborted turn",
    );
    assert.equal(
      spans.find((s) => s.name === "harness.tool search"),
      undefined,
      "no TOOL child should be synthesized after an aborted turn",
    );
    // Belt-and-suspenders: every finished span other than the turn must end
    // at-or-before the turn (i.e. there are no orphan children past the parent).
    for (const s of spans) {
      if (s.name === "harness.stream") continue;
      assert.ok(
        toHr(s.endTime) <= turnEnd,
        `span ${s.name} ended after the aborted turn span`,
      );
    }
  });

  void it("removes the abort listener on NORMAL completion (no listener leak)", async () => {
    // Regression for Eve round 2: `{ once: true }` only detaches after an abort
    // fires; a normally-completed turn must still removeEventListener its
    // handler, or a reused AbortController accumulates one listener per turn.
    const controller = new AbortController();
    // Spy on add/remove and track the registered handler so we can assert the
    // exact same reference is removed.
    const real = controller.signal;
    let added: EventListenerOrEventListenerObject | undefined;
    let removed: EventListenerOrEventListenerObject | undefined;
    const origAdd = real.addEventListener.bind(real);
    const origRemove = real.removeEventListener.bind(real);
    real.addEventListener = ((type: string, h: never, opts?: never) => {
      if (type === "abort") added = h;
      return origAdd(type, h, opts);
    }) as typeof real.addEventListener;
    real.removeEventListener = ((type: string, h: never, opts?: never) => {
      if (type === "abort") removed = h;
      return origRemove(type, h, opts);
    }) as typeof real.removeEventListener;

    const agent = instrumentHarnessAgent(
      mkAgent({
        streamResult: {
          text: "final",
          stream: mkStream([{ type: "text-delta", text: "hi" }]),
        },
      }),
    );

    const result = (await agent.stream({
      prompt: "go",
      abortSignal: real,
    })) as { stream: AsyncIterable<StreamPart> };
    // Listener was attached for the turn.
    assert.ok(added, "abort listener was not attached");
    // Round-3 model: the turn is finished EAGERLY from the result at resolve, so
    // the listener is detached now (before the user drains). It must be the SAME
    // handler reference and detached exactly once.
    assert.ok(removed, "abort listener was NOT removed on the eager finish");
    assert.equal(removed, added, "a different handler reference was removed");

    // Drain to normal completion — no second add/remove churn.
    const removedRef = removed;
    await drain(result.stream);
    assert.equal(removed, removedRef, "listener add/remove churned during drain");

    const turn = exporter
      .getFinishedSpans()
      .find((s) => s.name === "harness.stream");
    assert.ok(turn, "turn span missing");
    assert.equal(turn.status.code, 1); // OK — completed normally, not aborted
  });

  void it("concurrent turns dedupe independently (turn-scoped signal)", async () => {
    // Two interleaved turns sharing one process: turn A is Core-routed (fires
    // markCoreTelemetryFired inside its own call frame) and must SUPPRESS its
    // synthesized children; turn B is NOT Core-routed and must SYNTHESIZE its
    // own. The turn-scoped signal must keep them independent even though A's
    // Core-telemetry fire happens while B is mid-flight.
    const agentA = instrumentHarnessAgent(
      mkAgent({
        harness: "harness-a",
        streamFiresCoreTelemetry: true,
        streamResult: {
          text: "a",
          stream: mkStream([
            { type: "text-delta", text: "a-text" },
            {
              type: "tool-call",
              toolCallId: "a-tc",
              toolName: "search-a",
              input: {},
            },
            { type: "tool-result", toolCallId: "a-tc", output: {} },
          ]),
        },
      }),
    );
    const agentB = instrumentHarnessAgent(
      mkAgent({
        harness: "harness-b",
        streamResult: {
          text: "b",
          stream: mkStream([
            { type: "text-delta", text: "b-text" },
            {
              type: "tool-call",
              toolCallId: "b-tc",
              toolName: "search-b",
              input: {},
            },
            { type: "tool-result", toolCallId: "b-tc", output: {} },
          ]),
        },
      }),
    );

    // Kick off both, then drain interleaved.
    const [ra, rb] = (await Promise.all([
      agentA.stream({ prompt: "a?" }),
      agentB.stream({ prompt: "b?" }),
    ])) as Array<{ stream: AsyncIterable<StreamPart> }>;
    await Promise.all([drain(ra.stream), drain(rb.stream)]);

    const spans = exporter.getFinishedSpans();
    // Turn A (Core-routed) must NOT synthesize children.
    assert.equal(
      spans.find((s) => s.name === "harness.tool search-a"),
      undefined,
      "Core-routed turn A wrongly synthesized a tool span",
    );
    // Turn B (not Core-routed) MUST synthesize its own children.
    assert.ok(
      spans.find((s) => s.name === "harness.tool search-b"),
      "non-Core turn B failed to synthesize its tool span",
    );
    assert.ok(
      spans.find((s) => s.name === "harness.llm"),
      "non-Core turn B failed to synthesize its llm span",
    );
  });

  void it("harnessTelemetry returns an integration instance", () => {
    const tel = harnessTelemetry();
    assert.ok(tel.integration);
    const a = harnessTelemetry();
    assert.notEqual(tel.integration, a.integration);
  });

  void it("instrumentHarnessAgent is a no-op when Laminar is not active", async () => {
    Object.defineProperty(Laminar, "isInitialized", {
      value: false,
      writable: true,
    });
    delete process.env.LMNR_PROJECT_API_KEY;
    const agent = instrumentHarnessAgent(
      mkAgent({ generateResult: { text: "ok" } }),
    );
    const result = await agent.generate({ prompt: "x" });
    assert.equal((result as { text: string }).text, "ok");
    assert.equal(exporter.getFinishedSpans().length, 0);
  });
});
