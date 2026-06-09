import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, type Span, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  peekActiveLlmSpan,
  pushActiveLlmSpan,
  removeActiveLlmSpan,
} from "../src/opentelemetry-lib/instrumentation/aisdk/active-llm-span";
import {
  LaminarAiSdkTelemetry,
} from "../src/opentelemetry-lib/instrumentation/aisdk/v7-integration";

const mkStart = (callId: string) => ({
  callId,
  operationId: "ai.generateText",
  provider: "openai",
  modelId: "gpt-4.1-nano",
  messages: [{ role: "user", content: "hi" }],
  system: "you are helpful",
});

const mkStepStart = (callId: string, stepNumber: number) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  stepNumber,
  messages: [{ role: "user", content: "hi" }],
});

const mkLlmStart = (callId: string) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  messages: [{ role: "user", content: "hi" }],
});

const mkLlmEnd = (callId: string) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  content: [{ type: "text", text: "hello" }],
  responseId: "resp-1",
});

const mkStepEnd = (callId: string, stepNumber: number) => ({
  callId,
  stepNumber,
  content: [{ type: "text", text: "hello" }],
  text: "hello",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  response: { messages: [] },
});

const mkFinish = (callId: string) => ({
  ...mkStepEnd(callId, 0),
  steps: [],
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

void describe("active-llm-span registry", () => {
  void it("peek returns the most recently pushed span (LIFO)", () => {
    const a = { id: "a" } as unknown as Span;
    const b = { id: "b" } as unknown as Span;
    assert.equal(peekActiveLlmSpan(), undefined);
    pushActiveLlmSpan(a);
    pushActiveLlmSpan(b);
    assert.equal(peekActiveLlmSpan(), b);
    removeActiveLlmSpan(b);
    assert.equal(peekActiveLlmSpan(), a);
    removeActiveLlmSpan(a);
    assert.equal(peekActiveLlmSpan(), undefined);
  });

  void it("remove matches by reference and is a no-op for unknown spans", () => {
    const a = { id: "a" } as unknown as Span;
    pushActiveLlmSpan(a);
    removeActiveLlmSpan({ id: "other" } as unknown as Span);
    assert.equal(peekActiveLlmSpan(), a);
    removeActiveLlmSpan(a);
    assert.equal(peekActiveLlmSpan(), undefined);
  });
});

void describe("v7 integration publishes the LLM span to the registry", () => {
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

  void it("registers the llm span on callStart and removes it on callEnd", () => {
    const tel = new LaminarAiSdkTelemetry();
    const callId = "call-1";

    tel.onStart(mkStart(callId));
    tel.onStepStart(mkStepStart(callId, 0));
    // Before the llm call starts there is nothing registered.
    assert.equal(peekActiveLlmSpan(), undefined);

    tel.onLanguageModelCallStart(mkLlmStart(callId));
    const registered = peekActiveLlmSpan();
    assert.ok(registered, "llm span should be registered while the call runs");

    tel.onLanguageModelCallEnd(mkLlmEnd(callId));
    // Once the call ends, the registry is clear again.
    assert.equal(peekActiveLlmSpan(), undefined);

    tel.onStepFinish(mkStepEnd(callId, 0));
    tel.onEnd(mkFinish(callId));

    // The registered span is the LLM span (not the operation/step span).
    const spans = exporter.getFinishedSpans();
    const llm = spans.find((s) => s.name.startsWith("ai.llm "));
    assert.ok(llm);
    assert.equal(
      (registered as unknown as { spanContext: () => { spanId: string } })
        .spanContext().spanId,
      llm.spanContext().spanId,
    );
  });

  void it("orphan-sweep on abort removes the registered llm span", () => {
    const tel = new LaminarAiSdkTelemetry();
    const callId = "call-2";

    tel.onStart(mkStart(callId));
    tel.onStepStart(mkStepStart(callId, 0));
    tel.onLanguageModelCallStart(mkLlmStart(callId));
    assert.ok(peekActiveLlmSpan());

    // No callEnd / stepFinish — abort forces the orphan sweep.
    tel.onAbort({ callId });
    assert.equal(peekActiveLlmSpan(), undefined);
  });
});
