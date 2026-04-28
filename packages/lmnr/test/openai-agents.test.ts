import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { Laminar } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import {
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY,
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY_RAW,
  OpenAIAgentsInstrumentation,
} from "../src/opentelemetry-lib/instrumentation/openai-agents";
import {
  getCurrentSystemInstructions,
  runWithSystemInstructions,
  wrapStreamWithSystemInstructions,
} from "../src/opentelemetry-lib/instrumentation/openai-agents/helpers";
import {
  applyLlmAttributes,
  setGenAiInputMessages,
  setGenAiOutputMessages,
  setGenAiOutputMessagesFromResponse,
  setLmnrSpanIo,
  setToolDefinitionsFromResponse,
} from "../src/opentelemetry-lib/instrumentation/openai-agents/messages";
import {
  LaminarAgentsTraceProcessor,
} from "../src/opentelemetry-lib/instrumentation/openai-agents/processor";
import {
  applySpanData,
} from "../src/opentelemetry-lib/instrumentation/openai-agents/span-data";
import { LaminarContextManager } from "../src/opentelemetry-lib/tracing/context";
import { decompressRecordingResponse } from "./utils";

const captureAttrs = () => {
  const captured: Record<string, any> = {};
  const status: { code?: number; message?: string } = {};
  const span = {
    setAttribute: (k: string, v: any) => {
      captured[k] = v;
    },
    setStatus: (s: { code: number; message?: string }) => {
      status.code = s.code;
      status.message = s.message;
    },
    end: () => {},
  } as any;
  return { span, captured, status };
};

void describe("openai-agents helpers", () => {
  void it("DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY has expected raw name", () => {
    assert.strictEqual(
      DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY_RAW,
      "LMNR_DISABLE_OPENAI_RESPONSES_INSTRUMENTATION",
    );
    assert.ok(DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY);
  });

  void it("runWithSystemInstructions exposes value to getCurrentSystemInstructions", () => {
    assert.strictEqual(getCurrentSystemInstructions(), undefined);
    const seen = runWithSystemInstructions("be helpful", () =>
      getCurrentSystemInstructions(),
    );
    assert.strictEqual(seen, "be helpful");
    // Restored
    assert.strictEqual(getCurrentSystemInstructions(), undefined);
  });

  void it("concurrent tasks see isolated system instructions", async () => {
    const scenario = async (prompt: string) =>
      await runWithSystemInstructions(prompt, async () => {
        // yield to event loop; other tasks should not see our value
        await new Promise((resolve) => setImmediate(resolve));
        return getCurrentSystemInstructions();
      });

    const results = await Promise.all([scenario("alpha"), scenario("beta")]);
    assert.deepStrictEqual(results.sort(), ["alpha", "beta"]);
    assert.strictEqual(getCurrentSystemInstructions(), undefined);
  });

  void it("wrapStreamWithSystemInstructions keeps value visible across iterations", async () => {
    const source = (async function* () {
      yield getCurrentSystemInstructions();
      await new Promise((resolve) => setImmediate(resolve));
      yield getCurrentSystemInstructions();
    })();

    const wrapped = wrapStreamWithSystemInstructions("sys-a", source);
    const chunks: (string | undefined)[] = [];
    for await (const chunk of wrapped) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, ["sys-a", "sys-a"]);
    assert.strictEqual(getCurrentSystemInstructions(), undefined);
  });
});

void describe("openai-agents messages helpers", () => {
  void it("setGenAiInputMessages without system instructions is unchanged", () => {
    const { span, captured } = captureAttrs();
    setGenAiInputMessages(span, "hello there");
    const messages = JSON.parse(captured["gen_ai.input.messages"]);
    assert.deepStrictEqual(messages, [{ role: "user", content: "hello there" }]);
  });

  void it("setGenAiInputMessages prepends system instructions", () => {
    const { span, captured } = captureAttrs();
    setGenAiInputMessages(
      span,
      [{ role: "user", content: "What is 2+2?" }],
      "You are a calculator.",
    );
    const messages = JSON.parse(captured["gen_ai.input.messages"]);
    assert.deepStrictEqual(messages, [
      {
        role: "system",
        content: [{ type: "input_text", text: "You are a calculator." }],
      },
      { role: "user", content: "What is 2+2?" },
    ]);
  });

  void it("setGenAiInputMessages system-only still emits messages", () => {
    const { span, captured } = captureAttrs();
    setGenAiInputMessages(span, null, "Always respond in French.");
    const messages = JSON.parse(captured["gen_ai.input.messages"]);
    assert.deepStrictEqual(messages, [
      {
        role: "system",
        content: [{ type: "input_text", text: "Always respond in French." }],
      },
    ]);
  });

  void it("setGenAiInputMessages is a noop when both missing", () => {
    const { span, captured } = captureAttrs();
    setGenAiInputMessages(span, null, undefined);
    assert.deepStrictEqual(captured, {});
  });

  void it("setGenAiOutputMessages defaults role to assistant", () => {
    const { span, captured } = captureAttrs();
    setGenAiOutputMessages(span, "hello world");
    const messages = JSON.parse(captured["gen_ai.output.messages"]);
    assert.deepStrictEqual(messages, [
      { role: "assistant", content: "hello world" },
    ]);
  });

  void it("setGenAiOutputMessagesFromResponse wraps output with id/object", () => {
    const { span, captured } = captureAttrs();
    setGenAiOutputMessagesFromResponse(span, {
      id: "resp_123",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    });
    const parsed = JSON.parse(captured["gen_ai.output.messages"]);
    assert.strictEqual(parsed.id, "resp_123");
    assert.strictEqual(parsed.object, "response");
    assert.strictEqual(parsed.output.length, 1);
  });

  void it("setToolDefinitionsFromResponse flattens function tools", () => {
    const { span, captured } = captureAttrs();
    setToolDefinitionsFromResponse(span, {
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "weather fn",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    });
    const parsed = JSON.parse(captured["gen_ai.tool.definitions"]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].type, "function");
    assert.strictEqual(parsed[0].function.name, "get_weather");
    assert.strictEqual(parsed[0].function.strict, true);
  });

  void it("applyLlmAttributes records model, usage, response_id", () => {
    const { span, captured } = captureAttrs();
    applyLlmAttributes(span, {
      model: "gpt-4o-mini",
      response_id: "resp_456",
      usage: {
        input_tokens: 25,
        output_tokens: 8,
        total_tokens: 33,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
    assert.strictEqual(captured["gen_ai.request.model"], "gpt-4o-mini");
    assert.strictEqual(captured["gen_ai.response.model"], "gpt-4o-mini");
    assert.strictEqual(captured["gen_ai.system"], "openai");
    assert.strictEqual(captured["gen_ai.usage.input_tokens"], 25);
    assert.strictEqual(captured["gen_ai.usage.output_tokens"], 8);
    assert.strictEqual(captured["llm.usage.total_tokens"], 33);
    assert.strictEqual(captured["gen_ai.usage.cache_read_input_tokens"], 4);
    assert.strictEqual(captured["gen_ai.usage.reasoning_output_tokens"], 2);
    assert.strictEqual(captured["gen_ai.response.id"], "resp_456");
  });

  void it("setLmnrSpanIo serializes input and output", () => {
    const { span, captured } = captureAttrs();
    setLmnrSpanIo(span, { foo: "bar" }, [1, 2, 3]);
    assert.strictEqual(captured["lmnr.span.input"], JSON.stringify({ foo: "bar" }));
    assert.strictEqual(captured["lmnr.span.output"], JSON.stringify([1, 2, 3]));
  });
});

void describe("openai-agents span-data dispatcher", () => {
  void it("agent span data records name/handoffs/tools as input", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "agent",
      name: "WeatherBot",
      handoffs: ["OtherAgent"],
      tools: ["get_weather"],
      output_type: "str",
    });
    const input = JSON.parse(captured["lmnr.span.input"]);
    assert.strictEqual(input.name, "WeatherBot");
    assert.deepStrictEqual(input.handoffs, ["OtherAgent"]);
    assert.deepStrictEqual(input.tools, ["get_weather"]);
    assert.strictEqual(input.output_type, "str");
  });

  void it("function span data records input/output", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "function",
      input: { city: "NYC" },
      output: "72F and sunny",
    });
    const input = JSON.parse(captured["lmnr.span.input"]);
    const output = JSON.parse(captured["lmnr.span.output"]);
    assert.deepStrictEqual(input, { city: "NYC" });
    assert.strictEqual(output, "72F and sunny");
  });

  void it("response span prefers private _response field", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "response",
      _response: {
        id: "resp_1",
        model: "gpt-4o-mini",
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        tools: [],
      },
      _input: [{ role: "user", content: "hi" }],
    });
    assert.strictEqual(captured["gen_ai.request.model"], "gpt-4o-mini");
    assert.strictEqual(captured["gen_ai.response.id"], "resp_1");
    const input = JSON.parse(captured["gen_ai.input.messages"]);
    assert.deepStrictEqual(input, [{ role: "user", content: "hi" }]);
    const output = JSON.parse(captured["gen_ai.output.messages"]);
    assert.strictEqual(output.id, "resp_1");
  });

  void it("response span records response_id when body stripped", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "response",
      response_id: "resp_stripped",
    });
    assert.strictEqual(captured["gen_ai.response.id"], "resp_stripped");
  });

  void it("handoff span records from/to attributes", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "handoff",
      from_agent: "A",
      to_agent: { name: "B" },
    });
    assert.strictEqual(captured["openai.agents.handoff.from"], "A");
    assert.strictEqual(captured["openai.agents.handoff.to"], "B");
  });

  void it("guardrail span records name/triggered", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "guardrail",
      name: "policy",
      triggered: true,
    });
    assert.strictEqual(captured["openai.agents.guardrail.name"], "policy");
    assert.strictEqual(captured["openai.agents.guardrail.triggered"], true);
  });

  void it("custom span records data JSON", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "custom",
      name: "my-span",
      data: { foo: 1 },
    });
    assert.strictEqual(captured["openai.agents.custom.name"], "my-span");
    assert.strictEqual(
      captured["openai.agents.custom.data"],
      JSON.stringify({ foo: 1 }),
    );
  });

  void it("generation span applies llm attributes and messages", () => {
    const { span, captured } = captureAttrs();
    applySpanData(span, {
      type: "generation",
      model: "gpt-4o-mini",
      response_id: "resp_gen_1",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      input: [{ role: "user", content: "hi" }],
      output: "hello",
    });
    assert.strictEqual(captured["gen_ai.request.model"], "gpt-4o-mini");
    assert.strictEqual(captured["gen_ai.response.id"], "resp_gen_1");
    const input = JSON.parse(captured["gen_ai.input.messages"]);
    assert.deepStrictEqual(input, [{ role: "user", content: "hi" }]);
    const output = JSON.parse(captured["gen_ai.output.messages"]);
    assert.deepStrictEqual(output, [{ role: "assistant", content: "hello" }]);
  });
});

void describe("LaminarAgentsTraceProcessor", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  const fakeTrace = (overrides: Partial<any> = {}): any => ({
    traceId: "trace_123",
    name: "my-trace",
    groupId: "grp-1",
    metadata: { session_id: "sess-1", user_id: "user-1" },
    ...overrides,
  });

  const fakeSpan = (overrides: Partial<any>): any => ({
    traceId: "trace_123",
    spanId: `span_${Math.random().toString(36).slice(2)}`,
    parentId: null,
    error: null,
    ...overrides,
  });

  void it("writes a root trace span with metadata", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());
    await processor.onTraceEnd(fakeTrace());
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 1);
    const root = spans.find((s) => s.name === "my-trace");
    assert.ok(root, "expected root span named 'my-trace'");
  });

  void it("creates nested response span under trace root", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());

    const responseSpan = fakeSpan({
      name: null,
      spanData: {
        type: "response",
        _response: {
          id: "resp_1",
          model: "gpt-4o-mini",
          output: [
            { type: "message", content: [{ type: "output_text", text: "4" }] },
          ],
          usage: { input_tokens: 25, output_tokens: 8, total_tokens: 33 },
          tools: [],
        },
        _input: [{ role: "user", content: "What is 2+2?" }],
      },
    });

    await processor.onSpanStart(responseSpan);
    await processor.onSpanEnd(responseSpan);
    await processor.onTraceEnd(fakeTrace());
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    const resp = spans.find(
      (s) => s.attributes["gen_ai.request.model"] === "gpt-4o-mini",
    );
    assert.ok(resp, "expected a span with request model gpt-4o-mini");
    assert.strictEqual(resp.attributes["gen_ai.response.id"], "resp_1");
    assert.strictEqual(resp.attributes["gen_ai.usage.input_tokens"], 25);
    assert.strictEqual(resp.attributes["gen_ai.usage.output_tokens"], 8);
    assert.strictEqual(resp.attributes["llm.usage.total_tokens"], 33);
  });

  void it("prepends system instructions to response input messages", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());

    const responseSpan = fakeSpan({
      name: null,
      spanData: {
        type: "response",
        _response: {
          id: "resp_sys",
          model: "gpt-4o-mini",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
        _input: [{ role: "user", content: "Hi" }],
      },
    });

    await runWithSystemInstructions("You are a calculator.", async () => {
      await processor.onSpanStart(responseSpan);
      await processor.onSpanEnd(responseSpan);
    });

    await processor.onTraceEnd(fakeTrace());
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    const resp = spans.find(
      (s) => s.attributes["gen_ai.response.id"] === "resp_sys",
    );
    assert.ok(resp);
    const input = JSON.parse(resp.attributes["gen_ai.input.messages"] as string);
    assert.deepStrictEqual(input[0], {
      role: "system",
      content: [{ type: "input_text", text: "You are a calculator." }],
    });
    assert.deepStrictEqual(input[1], { role: "user", content: "Hi" });
  });

  void it("marks TOOL spans for function span types", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());

    const toolSpan = fakeSpan({
      name: null,
      spanData: {
        type: "function",
        name: "get_weather",
        input: { city: "NYC" },
        output: "72F",
      },
    });

    await processor.onSpanStart(toolSpan);
    await processor.onSpanEnd(toolSpan);
    await processor.onTraceEnd(fakeTrace());
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    const toolSpanExported = spans.find(
      (s) => s.attributes["lmnr.span.type"] === "TOOL",
    );
    assert.ok(toolSpanExported, "expected a TOOL-typed span");
    assert.strictEqual(toolSpanExported.name, "get_weather");
  });

  void it(
    "nested Laminar.startSpan inherits the active agents span as parent",
    async () => {
      // Regression for the case where another Laminar instrumentation
      // (google-genai, anthropic, etc.) creates a span from inside an
      // @openai/agents tool / agent callback: the nested span must be
      // parented to the agents span, not become a root span in a separate
      // trace. The processor makes this work by activating each agents span
      // on Laminar's ALS context stack for the duration of the span.
      const processor = new LaminarAgentsTraceProcessor();
      processor.start();

      const t = fakeTrace({ traceId: "trace_nested_parent", name: "t" });
      await processor.onTraceStart(t);

      const agentsSpan = fakeSpan({
        traceId: "trace_nested_parent",
        spanId: "span_parent",
        name: null,
        spanData: {
          type: "function",
          name: "tool_outer",
          input: "x",
          output: "y",
        },
      });
      await processor.onSpanStart(agentsSpan);

      // Simulate a nested Laminar-instrumented call.
      const nested = Laminar.startSpan({ name: "nested.llm", spanType: "LLM" });
      nested.end();

      await processor.onSpanEnd(agentsSpan);
      await processor.onTraceEnd(t);
      await Laminar.flush();

      const spans = exporter.getFinishedSpans();
      const nestedSpan = spans.find((s) => s.name === "nested.llm");
      const toolSpan = spans.find((s) => s.name === "tool_outer");
      assert.ok(nestedSpan && toolSpan, "expected both spans exported");
      assert.strictEqual(
        nestedSpan.spanContext().traceId,
        toolSpan.spanContext().traceId,
        "nested span must share the agents trace id",
      );
      const nestedParent =
        (nestedSpan as any).parentSpanContext?.spanId
        ?? (nestedSpan as any).parentSpanId;
      assert.strictEqual(
        nestedParent,
        toolSpan.spanContext().spanId,
        "nested span must be parented to the active agents span",
      );
    },
  );

  void it("idempotent onTraceEnd", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());
    await processor.onTraceEnd(fakeTrace());
    await processor.onTraceEnd(fakeTrace());
    await Laminar.flush();

    const rootSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "my-trace");
    assert.strictEqual(rootSpans.length, 1);
  });

  void it("shutdown ends pending spans and flushes", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();
    await processor.onTraceStart(fakeTrace());

    const dangling = fakeSpan({
      name: null,
      spanData: { type: "function", input: "x", output: "y" },
    });
    await processor.onSpanStart(dangling);

    await processor.shutdown();
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 2);
  });

  void it("concurrent traces keep their spans isolated", async () => {
    const processor = new LaminarAgentsTraceProcessor();
    processor.start();

    const traceA = fakeTrace({ traceId: "trace_A", name: "trace-A" });
    const traceB = fakeTrace({ traceId: "trace_B", name: "trace-B" });

    // Start both traces up-front so their root spans live on the shared
    // global stack at the same time.
    await processor.onTraceStart(traceA);
    await processor.onTraceStart(traceB);

    const childA = fakeSpan({
      traceId: "trace_A",
      spanId: "span_A_child",
      name: null,
      spanData: { type: "function", name: "tool_A", input: "a", output: "a" },
    });
    const childB = fakeSpan({
      traceId: "trace_B",
      spanId: "span_B_child",
      name: null,
      spanData: { type: "function", name: "tool_B", input: "b", output: "b" },
    });

    // Interleave starts from trace A and trace B — if child spans used the
    // process-global context, childB could end up under traceA's root.
    await processor.onSpanStart(childA);
    await processor.onSpanStart(childB);
    await processor.onSpanEnd(childA);
    await processor.onSpanEnd(childB);

    await processor.onTraceEnd(traceA);
    await processor.onTraceEnd(traceB);
    await Laminar.flush();

    const spans = exporter.getFinishedSpans();
    const toolA = spans.find((s) => s.name === "tool_A");
    const toolB = spans.find((s) => s.name === "tool_B");
    const rootA = spans.find((s) => s.name === "trace-A");
    const rootB = spans.find((s) => s.name === "trace-B");

    assert.ok(toolA && toolB && rootA && rootB);
    assert.strictEqual(
      toolA.spanContext().traceId,
      rootA.spanContext().traceId,
      "tool_A should live in trace A",
    );
    assert.strictEqual(
      toolB.spanContext().traceId,
      rootB.spanContext().traceId,
      "tool_B should live in trace B",
    );
    assert.notStrictEqual(
      rootA.spanContext().traceId,
      rootB.spanContext().traceId,
      "traces A and B should have distinct OTel trace ids",
    );
  });

  void it(
    "pushes onto ALS during a span's lifetime and removes cleanly on end",
    async () => {
      // The processor activates each agents span on the Laminar ALS stack so
      // that nested Laminar instrumentation (google-genai, etc.) running
      // inside tool / agent callbacks inherits the agents span as parent.
      // It must remove the entry by reference on onSpanEnd so that
      // out-of-order ends cannot corrupt entries belonging to unrelated
      // still-active spans on the same async frame.
      const processor = new LaminarAgentsTraceProcessor();
      processor.start();

      const baselineStack = LaminarContextManager.getContextStack().length;

      const fakeTraceObj = fakeTrace({ traceId: "trace_als", name: "t" });
      await processor.onTraceStart(fakeTraceObj);

      const childSpan = fakeSpan({
        traceId: "trace_als",
        spanId: "span_als_child",
        name: null,
        spanData: { type: "function", name: "tool", input: "x", output: "x" },
      });
      await processor.onSpanStart(childSpan);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack + 1,
        "onSpanStart must push the agents span onto ALS so nested "
          + "instrumentation inherits it",
      );

      await processor.onSpanEnd(childSpan);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack,
        "onSpanEnd must remove the activation entry",
      );

      await processor.onTraceEnd(fakeTraceObj);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack,
        "processor must leave ALS stack unchanged after ending trace",
      );
    },
  );

  void it(
    "removes activation entries by reference, surviving out-of-order ends",
    async () => {
      // Interleave starts/ends from two agent spans: if removal were a blind
      // LIFO pop, ending the *older* span first would drop the newer span's
      // entry. `removeContext` finds the exact reference instead.
      const processor = new LaminarAgentsTraceProcessor();
      processor.start();

      const fakeTraceObj = fakeTrace({ traceId: "trace_interleave", name: "t" });
      await processor.onTraceStart(fakeTraceObj);

      const baselineStack = LaminarContextManager.getContextStack().length;

      const spanA = fakeSpan({
        traceId: "trace_interleave",
        spanId: "span_A",
        name: null,
        spanData: { type: "function", name: "tool_A", input: "a", output: "a" },
      });
      const spanB = fakeSpan({
        traceId: "trace_interleave",
        spanId: "span_B",
        name: null,
        spanData: { type: "function", name: "tool_B", input: "b", output: "b" },
      });

      await processor.onSpanStart(spanA);
      await processor.onSpanStart(spanB);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack + 2,
        "both span activations must be on the stack",
      );

      // Out-of-LIFO end: close A before B.
      await processor.onSpanEnd(spanA);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack + 1,
        "ending A first must remove A's entry, leaving B's in place",
      );

      await processor.onSpanEnd(spanB);
      assert.strictEqual(
        LaminarContextManager.getContextStack().length,
        baselineStack,
        "ending B must clean up the remaining entry",
      );

      await processor.onTraceEnd(fakeTraceObj);
    },
  );
});

void describe("openai-agents end-to-end via nock", () => {
  const exporter = new InMemorySpanExporter();
  const recordingsDir = path.join(__dirname, "recordings");

  const loadRecording = (name: string) => {
    const file = path.join(recordingsDir, `openai-agents-${name}.json`);
    const recordings = JSON.parse(fs.readFileSync(file, "utf8"));
    nock.cleanAll();
    // The agents SDK retries the request across multiple turns; allow each
    // cassette entry to satisfy any number of matching requests.
    recordings.forEach((recording: nock.Definition & { rawHeaders?: any }) => {
      const response = decompressRecordingResponse(recording);
      nock(recording.scope)
        .persist()
        .intercept(recording.path, recording.method ?? "POST")
        .reply(recording.status, response, recording.rawHeaders ?? recording.headers);
    });
  };

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
  });

  void afterEach(() => {
    exporter.reset();
    nock.cleanAll();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("records response span with system instructions for a simple agent", async () => {
    loadRecording("simple-agent");

    const agentsModule = await import("@openai/agents");
    const { Agent, run, setTraceProcessors, setTracingDisabled } = agentsModule;

    // Ensure the processor list is empty, then attach ours manually so we
    // don't leak across tests. `setTraceProcessors([])` both removes previous
    // processors and initializes the trace provider on first call.
    setTracingDisabled(false);
    setTraceProcessors([]);
    const instrumentation = new OpenAIAgentsInstrumentation();
    instrumentation.manuallyInstrument({
      addTraceProcessor: (p: any) => setTraceProcessors([p]),
      OpenAIResponsesModel: agentsModule.OpenAIResponsesModel,
      OpenAIChatCompletionsModel: agentsModule.OpenAIChatCompletionsModel,
    });

    const agent = new Agent({
      name: "Assistant",
      instructions: "You are a helpful assistant.",
      model: "gpt-4o-mini",
    });

    const result = await run(agent, "What is 2+2?");
    assert.ok(result.finalOutput);
    assert.match(String(result.finalOutput), /4/);

    await Laminar.flush();
    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length > 0);

    const responseSpan = spans.find(
      (s) => s.attributes["gen_ai.request.model"] === "gpt-4o-mini",
    );
    assert.ok(responseSpan, "expected a response span with model gpt-4o-mini");
    assert.strictEqual(responseSpan.attributes["gen_ai.system"], "openai");
    assert.strictEqual(responseSpan.attributes["gen_ai.usage.input_tokens"], 25);
    assert.strictEqual(responseSpan.attributes["gen_ai.usage.output_tokens"], 8);
    assert.strictEqual(responseSpan.attributes["llm.usage.total_tokens"], 33);
    assert.strictEqual(
      responseSpan.attributes["gen_ai.response.id"],
      "resp_test_simple_agent",
    );

    const input = JSON.parse(
      responseSpan.attributes["gen_ai.input.messages"] as string,
    );
    assert.deepStrictEqual(input[0], {
      role: "system",
      content: [
        { type: "input_text", text: "You are a helpful assistant." },
      ],
    });

    // Every non-root span produced by the agents run should be parented under
    // some other span in the same trace — i.e. the tree should have exactly
    // one root. This catches regressions where spans from unrelated async
    // callbacks end up flattened at the trace root.
    const traceId = responseSpan.spanContext().traceId;
    const sameTrace = spans.filter((s) => s.spanContext().traceId === traceId);
    const getParent = (s: typeof spans[number]): string | undefined => {
      const anyS = s as any;
      return (anyS.parentSpanId ?? anyS.parentSpanContext?.spanId) as
        | string
        | undefined;
    };
    const roots = sameTrace.filter((s) => !getParent(s));
    assert.strictEqual(
      roots.length,
      1,
      `expected a single root span in trace, got ${roots.length}: ` +
        sameTrace.map((s) => `${s.name}(parent=${getParent(s) ?? "none"})`)
          .join(", "),
    );
  });
});
