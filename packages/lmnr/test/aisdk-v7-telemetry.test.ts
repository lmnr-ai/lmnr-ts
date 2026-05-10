import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { wrapAISDK } from "../src/opentelemetry-lib/instrumentation/aisdk";
import {
  LaminarTelemetry,
  laminarTelemetry,
  registerLaminarTelemetry,
} from "../src/opentelemetry-lib/instrumentation/aisdk/v7";
import {
  SPAN_INPUT,
  SPAN_TYPE,
} from "../src/opentelemetry-lib/tracing/attributes";

// Minimal synthetic v7 events — we don't need the real `ai` package runtime
// to test our Telemetry class; only the shapes. This mirrors how v7 would
// drive the integration in the real call path.

const mkStartEvent = (
  callId: string,
  overrides: Record<string, unknown> = {},
) => ({
  callId,
  operationId: "ai.generateText",
  provider: "openai",
  modelId: "gpt-4.1-nano",
  messages: [{ role: "user", content: "hi" }],
  system: "you are helpful",
  tools: undefined,
  toolChoice: undefined,
  activeTools: undefined,
  maxRetries: 2,
  timeout: undefined,
  headers: undefined,
  providerOptions: undefined,
  output: undefined,
  toolsContext: undefined,
  runtimeContext: undefined,
  ...overrides,
});

const mkStepStartEvent = (
  callId: string,
  stepNumber: number,
  overrides: Record<string, unknown> = {},
) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  stepNumber,
  tools: undefined,
  toolChoice: undefined,
  activeTools: undefined,
  steps: [],
  providerOptions: undefined,
  output: undefined,
  runtimeContext: undefined,
  toolsContext: undefined,
  system: "you are helpful",
  messages: [{ role: "user", content: "hi" }],
  ...overrides,
});

const mkLlmCallStart = (
  callId: string,
  overrides: Record<string, unknown> = {},
) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  tools: undefined,
  system: "you are helpful",
  messages: [{ role: "user", content: "hi" }],
  ...overrides,
});

const mkLlmCallEnd = (
  callId: string,
  overrides: Record<string, unknown> = {},
) => ({
  callId,
  provider: "openai",
  modelId: "gpt-4.1-nano",
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  content: [{ type: "text", text: "hello" }],
  responseId: "resp-123",
  ...overrides,
});

const mkStepEnd = (
  callId: string,
  stepNumber: number,
  overrides: Record<string, unknown> = {},
) => ({
  callId,
  stepNumber,
  model: { provider: "openai", modelId: "gpt-4.1-nano" },
  content: [{ type: "text", text: "hello" }],
  text: "hello",
  reasoning: [],
  reasoningText: undefined,
  files: [],
  sources: [],
  toolCalls: [],
  staticToolCalls: [],
  dynamicToolCalls: [],
  toolResults: [],
  staticToolResults: [],
  dynamicToolResults: [],
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  warnings: undefined,
  request: {},
  response: { messages: [] },
  providerMetadata: undefined,
  toolsContext: undefined,
  runtimeContext: undefined,
  ...overrides,
});

const mkFinish = (callId: string, overrides: Record<string, unknown> = {}) => ({
  ...mkStepEnd(callId, 0),
  steps: [],
  totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  ...overrides,
});

void describe("AI SDK v7 LaminarTelemetry integration", () => {
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

  void it("creates operation → step → llm span tree for generateText", () => {
    const tel = new LaminarTelemetry();
    const callId = "call-1";

    tel.onStart(mkStartEvent(callId));
    tel.onStepStart(mkStepStartEvent(callId, 0));
    tel.onLanguageModelCallStart(mkLlmCallStart(callId));
    tel.onLanguageModelCallEnd(mkLlmCallEnd(callId));
    tel.onStepFinish(mkStepEnd(callId, 0));
    tel.onFinish(mkFinish(callId));

    const spans = exporter.getFinishedSpans();
    const byName = new Map(spans.map((s) => [s.name, s]));

    const op = spans.find((s) => s.name === "ai.generateText");
    assert.ok(op, "operation span missing");
    assert.equal(op.attributes[SPAN_TYPE], "DEFAULT");
    assert.equal(op.attributes["ai.operation"], "ai.generateText");
    assert.equal(op.attributes["gen_ai.system"], "openai");
    assert.equal(op.attributes["gen_ai.request.model"], "gpt-4.1-nano");
    assert.equal(op.attributes["ai.response.text"], "hello");
    assert.equal(op.attributes["ai.response.finishReason"], "stop");

    const step = spans.find((s) => s.name === "ai.step 0");
    assert.ok(step, "step span missing");
    assert.equal(step.attributes[SPAN_TYPE], "DEFAULT");
    assert.equal(step.attributes["ai.step.number"], 0);
    assert.equal(step.parentSpanContext?.spanId, op.spanContext().spanId);

    const llm = spans.find((s) => s.name.startsWith("ai.llm "));
    assert.ok(llm, "llm span missing");
    assert.equal(llm.attributes[SPAN_TYPE], "LLM");
    assert.equal(llm.attributes["gen_ai.system"], "openai");
    assert.equal(llm.attributes["gen_ai.request.model"], "gpt-4.1-nano");
    assert.equal(llm.attributes["gen_ai.response.model"], "gpt-4.1-nano");
    assert.equal(llm.attributes["gen_ai.response.id"], "resp-123");
    assert.equal(llm.attributes["gen_ai.response.finish_reason"], "stop");
    assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(llm.attributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(llm.attributes["ai.response.text"], "hello");
    assert.equal(llm.parentSpanContext?.spanId, step.spanContext().spanId);

    // Hybrid attribute check: ai.prompt.messages includes the system prompt.
    const promptMessages = JSON.parse(
      step.attributes["ai.prompt.messages"] as string,
    );
    assert.equal(promptMessages[0].role, "system");
    assert.equal(promptMessages[0].content, "you are helpful");

    // All three span kinds present.
    assert.ok(byName.has("ai.generateText"));
    assert.ok(byName.has("ai.step 0"));
  });

  void it("makes tool spans flat siblings of llm under the step", () => {
    const tel = new LaminarTelemetry();
    const callId = "call-2";

    tel.onStart(mkStartEvent(callId));
    tel.onStepStart(mkStepStartEvent(callId, 0));

    // First: LLM returns a tool-call
    tel.onLanguageModelCallStart(mkLlmCallStart(callId));
    tel.onLanguageModelCallEnd(
      mkLlmCallEnd(callId, {
        finishReason: "tool-calls",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-abc",
            toolName: "lookup",
            input: { city: "SF" },
          },
        ],
      }),
    );

    // Tool call begins and ends under step 0, flat sibling of the LLM span.
    tel.onToolExecutionStart({
      callId,
      toolCall: {
        toolCallId: "tc-abc",
        toolName: "lookup",
        input: { city: "SF" },
      },
      messages: [],
      toolContext: undefined,
    });
    tel.onToolExecutionEnd({
      callId,
      durationMs: 12,
      toolCall: {
        toolCallId: "tc-abc",
        toolName: "lookup",
        input: { city: "SF" },
      },
      toolContext: undefined,
      messages: [],
      toolOutput: { type: "tool-result", output: { weather: "sunny" } },
    });

    // Then step 0 finishes (with the tool call recorded).
    tel.onStepFinish(
      mkStepEnd(callId, 0, {
        text: "",
        toolCalls: [
          {
            toolCallId: "tc-abc",
            toolName: "lookup",
            input: { city: "SF" },
          },
        ],
        finishReason: "tool-calls",
      }),
    );

    // Step 1: a second LLM call that finalizes the answer.
    tel.onStepStart(mkStepStartEvent(callId, 1));
    tel.onLanguageModelCallStart(mkLlmCallStart(callId));
    tel.onLanguageModelCallEnd(mkLlmCallEnd(callId));
    tel.onStepFinish(mkStepEnd(callId, 1));
    tel.onFinish(mkFinish(callId, { stepNumber: 1 }));

    const spans = exporter.getFinishedSpans();

    const op = spans.find((s) => s.name === "ai.generateText");
    assert.ok(op);
    const step0 = spans.find((s) => s.name === "ai.step 0");
    const step1 = spans.find((s) => s.name === "ai.step 1");
    assert.ok(step0 && step1);

    const tool = spans.find((s) => s.name === "ai.tool lookup");
    assert.ok(tool, "tool span missing");
    assert.equal(tool.attributes[SPAN_TYPE], "TOOL");
    assert.equal(tool.attributes["ai.toolCall.name"], "lookup");
    assert.equal(tool.attributes["ai.toolCall.id"], "tc-abc");
    assert.equal(tool.attributes["ai.toolCall.durationMs"], 12);
    assert.equal(tool.parentSpanContext?.spanId, step0.spanContext().spanId);

    // LLM siblings under each step.
    const llmSpans = spans.filter((s) => s.name.startsWith("ai.llm "));
    assert.equal(llmSpans.length, 2);
    assert.equal(
      llmSpans[0].parentSpanContext?.spanId,
      step0.spanContext().spanId,
    );
    assert.equal(
      llmSpans[1].parentSpanContext?.spanId,
      step1.spanContext().spanId,
    );
  });

  void it("propagates tool span as parent for nested generateText (sub-agent)", async () => {
    const tel = new LaminarTelemetry();
    const outerCallId = "outer-1";
    const innerCallId = "inner-1";

    tel.onStart(mkStartEvent(outerCallId));
    tel.onStepStart(mkStepStartEvent(outerCallId, 0));
    tel.onLanguageModelCallStart(mkLlmCallStart(outerCallId));
    tel.onLanguageModelCallEnd(
      mkLlmCallEnd(outerCallId, {
        finishReason: "tool-calls",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-x",
            toolName: "subagent",
            input: {},
          },
        ],
      }),
    );
    tel.onToolExecutionStart({
      callId: outerCallId,
      toolCall: { toolCallId: "tc-x", toolName: "subagent", input: {} },
      messages: [],
      toolContext: undefined,
    });

    // Drive a nested generateText inside executeTool.
    await tel.executeTool({
      callId: outerCallId,
      toolCallId: "tc-x",
      execute: () => {
        tel.onStart(
          mkStartEvent(innerCallId, { operationId: "ai.generateText" }),
        );
        tel.onStepStart(mkStepStartEvent(innerCallId, 0));
        tel.onLanguageModelCallStart(mkLlmCallStart(innerCallId));
        tel.onLanguageModelCallEnd(mkLlmCallEnd(innerCallId));
        tel.onStepFinish(mkStepEnd(innerCallId, 0));
        tel.onFinish(mkFinish(innerCallId));
        return Promise.resolve("ok");
      },
    });

    tel.onToolExecutionEnd({
      callId: outerCallId,
      durationMs: 1,
      toolCall: { toolCallId: "tc-x", toolName: "subagent", input: {} },
      toolContext: undefined,
      messages: [],
      toolOutput: { type: "tool-result", output: "ok" },
    });
    tel.onStepFinish(
      mkStepEnd(outerCallId, 0, {
        text: "",
        toolCalls: [{ toolCallId: "tc-x", toolName: "subagent", input: {} }],
        finishReason: "tool-calls",
      }),
    );
    tel.onFinish(mkFinish(outerCallId));

    const spans = exporter.getFinishedSpans();
    // The outer operation span's span id is shared — the inner operation
    // span's parent should be the outer tool span (tc-x).
    const outerTool = spans.find((s) => s.name === "ai.tool subagent");
    assert.ok(outerTool);

    const innerOpCandidates = spans.filter((s) => s.name === "ai.generateText");
    assert.equal(innerOpCandidates.length, 2);
    const innerOp = innerOpCandidates.find(
      (s) => s.parentSpanContext?.spanId === outerTool.spanContext().spanId,
    );
    assert.ok(
      innerOp,
      "inner operation span should be parented to the outer tool span",
    );
  });

  void it("records tool-error status when toolOutput is tool-error", () => {
    const tel = new LaminarTelemetry();
    const callId = "call-err";

    tel.onStart(mkStartEvent(callId));
    tel.onStepStart(mkStepStartEvent(callId, 0));
    tel.onToolExecutionStart({
      callId,
      toolCall: { toolCallId: "tc-err", toolName: "broken", input: {} },
      messages: [],
      toolContext: undefined,
    });
    tel.onToolExecutionEnd({
      callId,
      durationMs: 3,
      toolCall: { toolCallId: "tc-err", toolName: "broken", input: {} },
      toolContext: undefined,
      messages: [],
      toolOutput: { type: "tool-error", error: new Error("boom") },
    });
    tel.onStepFinish(mkStepEnd(callId, 0));
    tel.onFinish(mkFinish(callId));

    const spans = exporter.getFinishedSpans();
    const tool = spans.find((s) => s.name === "ai.tool broken");
    assert.ok(tool);
    assert.equal(tool.status.code, 2); // SpanStatusCode.ERROR
    assert.equal(tool.attributes["ai.toolCall.error"], "boom");
  });

  void it("creates a single LLM span for embed", () => {
    const tel = new LaminarTelemetry();
    const callId = "embed-1";

    tel.onStart({
      callId,
      operationId: "ai.embed",
      provider: "openai",
      modelId: "text-embedding-3-small",
      value: "hello world",
      maxRetries: 2,
      headers: undefined,
      providerOptions: undefined,
    });
    tel.onFinish({
      callId,
      operationId: "ai.embed",
      provider: "openai",
      modelId: "text-embedding-3-small",
      value: "hello world",
      embedding: [0.1, 0.2, 0.3],
      usage: { inputTokens: 3, totalTokens: 3 },
      warnings: [],
      providerMetadata: undefined,
      response: { headers: {}, body: {} },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const op = spans[0];
    assert.equal(op.name, "ai.embed");
    assert.equal(op.attributes[SPAN_TYPE], "LLM");
    assert.equal(op.attributes[SPAN_INPUT], "hello world");
    assert.equal(op.attributes["gen_ai.usage.input_tokens"], 3);
  });

  void it("records reasoning text via gen_ai.output.messages", () => {
    const tel = new LaminarTelemetry();
    const callId = "call-think";

    tel.onStart(mkStartEvent(callId));
    tel.onStepStart(mkStepStartEvent(callId, 0));
    tel.onLanguageModelCallStart(mkLlmCallStart(callId));
    tel.onLanguageModelCallEnd(
      mkLlmCallEnd(callId, {
        content: [
          { type: "reasoning", text: "Let me think..." },
          { type: "text", text: "42" },
        ],
      }),
    );
    tel.onStepFinish(mkStepEnd(callId, 0, { text: "42" }));
    tel.onFinish(mkFinish(callId, { text: "42" }));

    const spans = exporter.getFinishedSpans();
    const llm = spans.find((s) => s.name.startsWith("ai.llm "));
    assert.ok(llm);
    const outMsgs = JSON.parse(
      llm.attributes["gen_ai.output.messages"] as string,
    );
    assert.equal(outMsgs[0].role, "assistant");
    assert.equal(outMsgs[0].parts[0].type, "thinking");
    assert.equal(outMsgs[0].parts[0].content, "Let me think...");
    assert.equal(outMsgs[0].parts[1].type, "text");
    assert.equal(outMsgs[0].parts[1].content, "42");
  });

  void it("factory helpers create independent integrations", () => {
    const a = laminarTelemetry();
    const b = laminarTelemetry();
    assert.notEqual(a, b);
    assert.ok(a instanceof LaminarTelemetry);
  });

  void it("registerLaminarTelemetry appends to globalThis.AI_SDK_TELEMETRY_INTEGRATIONS", () => {
    const g = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
    const before = g.AI_SDK_TELEMETRY_INTEGRATIONS?.length ?? 0;
    const integration = registerLaminarTelemetry();
    assert.ok(Array.isArray(g.AI_SDK_TELEMETRY_INTEGRATIONS));
    assert.equal(g.AI_SDK_TELEMETRY_INTEGRATIONS.length, before + 1);
    assert.ok(g.AI_SDK_TELEMETRY_INTEGRATIONS.includes(integration));
    // Cleanup so subsequent tests don't accumulate.
    g.AI_SDK_TELEMETRY_INTEGRATIONS = g.AI_SDK_TELEMETRY_INTEGRATIONS.filter(
      (x) => x !== integration,
    );
  });

  void it(
    "wrapAISDK injects the v7 integration into call args when " +
      "registerTelemetry is present",
    async () => {
      const observed: unknown[] = [];
      const fakeAI = {
        registerTelemetry: () => {},
        generateText: (opts: unknown) => {
          observed.push(opts);
          return Promise.resolve({ text: "ok" });
        },
      } as unknown as Parameters<typeof wrapAISDK>[0];
      const wrapped = wrapAISDK(fakeAI);
      await (
        wrapped as unknown as { generateText: (o: unknown) => Promise<unknown> }
      ).generateText({ prompt: "hi" });
      const firstCall = observed[0] as {
        telemetry?: { integrations?: unknown[] };
      };
      assert.ok(firstCall.telemetry);
      assert.ok(Array.isArray(firstCall.telemetry.integrations));
      assert.ok(
        firstCall.telemetry.integrations.some(
          (i) => i instanceof LaminarTelemetry,
        ),
      );
    },
  );

  void it("onError scopes error to the callId on the event", () => {
    const tel = new LaminarTelemetry();
    tel.onStart(mkStartEvent("call-A"));
    tel.onStart(mkStartEvent("call-B"));

    tel.onError({ callId: "call-A", error: new Error("A broke") });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1, "only the errored op span should have ended");
    assert.equal(spans[0].name, "ai.generateText");
    assert.equal(spans[0].status.code, 2); // SpanStatusCode.ERROR
    assert.equal(spans[0].status.message, "A broke");

    // call-B must still be open and unaffected — onFinish will close it.
    tel.onFinish(mkFinish("call-B"));
    const after = exporter.getFinishedSpans();
    const b = after.find(
      (s) => s.name === "ai.generateText" && s.status.code !== 2,
    );
    assert.ok(b, "unrelated concurrent op must finish OK");
  });

  void it("onError does not flag unrelated ops when callId is missing and multiple are in flight", () => {
    const tel = new LaminarTelemetry();
    tel.onStart(mkStartEvent("call-X"));
    tel.onStart(mkStartEvent("call-Y"));

    tel.onError(new Error("ambiguous"));

    // No spans should have ended yet — we refused to guess which op failed.
    assert.equal(exporter.getFinishedSpans().length, 0);

    tel.onFinish(mkFinish("call-X"));
    tel.onFinish(mkFinish("call-Y"));
    const ended = exporter.getFinishedSpans();
    for (const s of ended) {
      assert.notEqual(s.status.code, 2, "no op should be marked errored");
    }
  });

  void it("onError closes step/llm/tool child spans for the errored callId", () => {
    const tel = new LaminarTelemetry();
    const callId = "call-leaky";
    tel.onStart(mkStartEvent(callId));
    tel.onStepStart(mkStepStartEvent(callId, 0));
    tel.onLanguageModelCallStart(mkLlmCallStart(callId));
    // Provider emits onError without onLanguageModelCallEnd / onStepFinish /
    // onFinish. Without cleanup those spans would leak forever.
    tel.onError({ callId, error: new Error("mid-stream") });

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    assert.deepEqual(names, [
      "ai.generateText",
      "ai.llm openai:gpt-4.1-nano",
      "ai.step 0",
    ]);
  });
});
