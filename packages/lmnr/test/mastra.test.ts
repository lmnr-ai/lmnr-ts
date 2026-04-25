import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import {
  LaminarMastraExporter,
  MastraInstrumentation,
} from "../src/opentelemetry-lib/instrumentation/mastra";
import {
  MastraSpanType,
  MastraTracingEventType,
} from "../src/opentelemetry-lib/instrumentation/mastra/types";

// These tests avoid pulling in a real `@mastra/core` runtime — they validate that
// the Laminar exporter correctly converts Mastra's observability events into
// OTel ReadableSpans that carry the attributes our backend expects.
void describe("mastra instrumentation", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void it("converts a Mastra AGENT_RUN span into a DEFAULT Laminar span", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "0123456789abcdef0123456789abcdef";
    const spanId = "0123456789abcdef";
    const started = new Date("2026-04-23T10:00:00.000Z");
    const ended = new Date("2026-04-23T10:00:01.000Z");

    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id: spanId,
        traceId,
        name: "agent.weatherAgent",
        type: MastraSpanType.AGENT_RUN,
        startTime: started,
        isRootSpan: true,
        isEvent: false,
      },
    });

    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: spanId,
        traceId,
        name: "agent.weatherAgent",
        type: MastraSpanType.AGENT_RUN,
        startTime: started,
        endTime: ended,
        input: { prompt: "What is the weather in SF?" },
        output: { text: "Sunny and warm" },
        isRootSpan: true,
        isEvent: false,
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const s = spans[0];
    assert.equal(s.name, "agent.weatherAgent");
    assert.equal(s.attributes["lmnr.span.type"], "DEFAULT");
    assert.deepEqual(s.attributes["lmnr.span.path"], ["agent.weatherAgent"]);
    assert.equal(s.attributes["lmnr.span.instrumentation_source"], "javascript");
    assert.equal(
      s.attributes["lmnr.span.input"],
      JSON.stringify({ prompt: "What is the weather in SF?" }),
    );
    assert.equal(
      s.attributes["lmnr.span.output"],
      JSON.stringify({ text: "Sunny and warm" }),
    );
  });

  void it("converts MODEL_GENERATION with usage into an LLM span with gen_ai.* attrs", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const rootId = "1111111111111111";
    const childId = "2222222222222222";
    const t0 = new Date("2026-04-23T10:10:00.000Z");
    const t1 = new Date("2026-04-23T10:10:00.500Z");
    const t2 = new Date("2026-04-23T10:10:01.000Z");

    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id: rootId,
        traceId,
        name: "agent.run",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        isRootSpan: true,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id: childId,
        traceId,
        name: "llm.generate",
        type: MastraSpanType.MODEL_GENERATION,
        startTime: t1,
        parentSpanId: rootId,
        isRootSpan: false,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: childId,
        traceId,
        name: "llm.generate",
        type: MastraSpanType.MODEL_GENERATION,
        startTime: t1,
        endTime: t2,
        parentSpanId: rootId,
        input: { messages: [{ role: "user", content: "hi" }] },
        output: "hello!",
        attributes: {
          provider: "openai.chat",
          model: "gpt-4o-mini",
          responseModel: "gpt-4o-mini-2024-07-18",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            inputDetails: { cacheRead: 3 },
          },
        },
        isRootSpan: false,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: rootId,
        traceId,
        name: "agent.run",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        endTime: t2,
        isRootSpan: true,
        isEvent: false,
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);

    const llmSpan = spans.find((s) => s.name === "llm.generate")!;
    assert.equal(llmSpan.attributes["lmnr.span.type"], "LLM");
    assert.deepEqual(llmSpan.attributes["lmnr.span.path"], [
      "agent.run",
      "llm.generate",
    ]);
    assert.equal(llmSpan.attributes["gen_ai.system"], "openai");
    assert.equal(llmSpan.attributes["gen_ai.request.model"], "gpt-4o-mini");
    assert.equal(
      llmSpan.attributes["gen_ai.response.model"],
      "gpt-4o-mini-2024-07-18",
    );
    assert.equal(llmSpan.attributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(llmSpan.attributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(llmSpan.attributes["gen_ai.usage.cache_read_input_tokens"], 3);

    // Verify the child span carries the parent's span id (hierarchy preserved).
    const parentContext = (llmSpan as any).parentSpanContext;
    assert.ok(parentContext);
    assert.equal(parentContext.spanId, rootId);
  });

  void it("maps TOOL_CALL spans to Laminar TOOL type", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const id = "3333333333333333";
    const t0 = new Date();
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id,
        traceId,
        name: "tool.weatherLookup",
        type: MastraSpanType.TOOL_CALL,
        startTime: t0,
        isRootSpan: true,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id,
        traceId,
        name: "tool.weatherLookup",
        type: MastraSpanType.TOOL_CALL,
        startTime: t0,
        endTime: new Date(t0.getTime() + 50),
        input: { location: "SF" },
        output: { temp: 72 },
        isRootSpan: true,
        isEvent: false,
      },
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes["lmnr.span.type"], "TOOL");
  });

  void it("manuallyInstrument wraps Mastra and injects an Observability instance", () => {
    class FakeMastra {
      public receivedConfig: any;
      constructor(config: any) {
        this.receivedConfig = config;
      }
    }
    const moduleExports: { Mastra: typeof FakeMastra } = { Mastra: FakeMastra };

    const instrumentation = new MastraInstrumentation();
    instrumentation.manuallyInstrument(moduleExports);

    // Module's Mastra export should be replaced with a wrapper.
    assert.notEqual(moduleExports.Mastra, FakeMastra);

    const instance: any = new moduleExports.Mastra({ agents: {} });
    const observability = instance.receivedConfig?.observability;
    // Mastra >=1.27 requires an Observability entrypoint (has
    // `getDefaultInstance`), not a raw registry-config object.
    assert.ok(observability, "observability should be set");
    assert.equal(typeof observability.getDefaultInstance, "function");
    const defaultInstance = observability.getDefaultInstance();
    assert.ok(defaultInstance, "default observability instance should exist");
  });

  void it("strips dashes from UUID-formatted trace and span ids", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "123e4567-e89b-12d3-a456-426614174000";
    const spanId = "abcd1234-ef56-7890";
    const parentId = "1111aaaa-2222-bbbb";
    const t0 = new Date();
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id: parentId,
        traceId,
        name: "parent",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        isRootSpan: true,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id: spanId,
        traceId,
        name: "child",
        type: MastraSpanType.TOOL_CALL,
        startTime: t0,
        parentSpanId: parentId,
        isRootSpan: false,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: spanId,
        traceId,
        name: "child",
        type: MastraSpanType.TOOL_CALL,
        startTime: t0,
        endTime: new Date(t0.getTime() + 10),
        parentSpanId: parentId,
        isRootSpan: false,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: parentId,
        traceId,
        name: "parent",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        endTime: new Date(t0.getTime() + 20),
        isRootSpan: true,
        isEvent: false,
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    const hexOnly = /^[0-9a-f]+$/;
    for (const s of spans) {
      const ctx = s.spanContext();
      assert.match(ctx.traceId, hexOnly, `traceId ${ctx.traceId} should be hex-only`);
      assert.equal(ctx.traceId.length, 32);
      assert.match(ctx.spanId, hexOnly, `spanId ${ctx.spanId} should be hex-only`);
      assert.equal(ctx.spanId.length, 16);
    }
    const child = spans.find((s) => s.name === "child")!;
    const parentCtx = (child as any).parentSpanContext;
    assert.ok(parentCtx);
    assert.match(parentCtx.spanId, hexOnly);
    assert.equal(parentCtx.spanId.length, 16);

    // spanIdsPath should derive deterministically from the dash-stripped span
    // ids, not fall back to random UUIDs. The child's ids_path must contain
    // the parent span's normalized id (same one emitted on the parent span).
    const parent = spans.find((s) => s.name === "parent")!;
    const parentIdsPath = parent.attributes["lmnr.span.ids_path"] as string[];
    const childIdsPath = child.attributes["lmnr.span.ids_path"] as string[];
    assert.ok(Array.isArray(parentIdsPath));
    assert.ok(Array.isArray(childIdsPath));
    assert.equal(childIdsPath[0], parentIdsPath[0]);
  });

  void it("filters out SPAN_ENDED events with isEvent=true", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "ddddddddddddddddddddddddddddddddd".slice(0, 32);
    const id = "5555555555555555";
    const t0 = new Date();
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id,
        traceId,
        name: "point.event",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        isRootSpan: true,
        isEvent: true,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id,
        traceId,
        name: "point.event",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        endTime: t0,
        isRootSpan: true,
        isEvent: true,
      },
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 0);
  });

  void it(
    "strips empty-user artifacts from MODEL_STEP input (Responses API tool rounds)",
    async () => {
      // Repro for the bug where `@mastra/observability`'s `normalizeMessages`
      // turns OpenAI Responses API `body.input` items like `function_call` /
      // `function_call_output` into `{role:"user", content:""}` entries,
      // because those items have no `role` / `content` of their own. We can't
      // recover the original tool-call payload, but the exporter must at least
      // drop the spurious empty user turns so step 1 doesn't look like the
      // user sent three empty messages.
      const mastraExporter = new LaminarMastraExporter();
      const traceId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const rootId = "6666666666666666";
      const childId = "7777777777777777";
      const t0 = new Date("2026-04-23T10:20:00.000Z");
      const t1 = new Date("2026-04-23T10:20:00.100Z");
      const t2 = new Date("2026-04-23T10:20:01.000Z");

      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_STARTED,
        exportedSpan: {
          id: rootId,
          traceId,
          name: "llm: 'gpt-5-mini'",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          isRootSpan: true,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_STARTED,
        exportedSpan: {
          id: childId,
          traceId,
          name: "step: 1",
          type: MastraSpanType.MODEL_STEP,
          startTime: t1,
          parentSpanId: rootId,
          isRootSpan: false,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_ENDED,
        exportedSpan: {
          id: childId,
          traceId,
          name: "step: 1",
          type: MastraSpanType.MODEL_STEP,
          startTime: t1,
          endTime: t2,
          parentSpanId: rootId,
          // This mirrors what Mastra 1.10 emits after a single tool-call round
          // on the Responses API: two empty `user` placeholders where the
          // `function_call` and `function_call_output` used to be.
          input: [
            {
              role: "system",
              content:
                "You are a helpful assistant. When asked to greet someone, use the greeting tool.",
            },
            { role: "user", content: "Say hello to Alice" },
            { role: "user", content: "" },
            { role: "user", content: "" },
          ],
          output: { text: "Hello Alice!" },
          isRootSpan: false,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_ENDED,
        exportedSpan: {
          id: rootId,
          traceId,
          name: "llm: 'gpt-5-mini'",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          endTime: t2,
          isRootSpan: true,
          isEvent: false,
        },
      });

      const stepSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === "step: 1")!;
      const serialized = stepSpan.attributes["lmnr.span.input"] as string;
      assert.ok(serialized, "MODEL_STEP should have an input attribute");
      const parsed = JSON.parse(serialized) as Array<{
        role: string;
        content: string;
      }>;
      assert.deepEqual(parsed, [
        {
          role: "system",
          content:
            "You are a helpful assistant. When asked to greet someone, use the greeting tool.",
        },
        { role: "user", content: "Say hello to Alice" },
      ]);
    },
  );

  void it("flattens metadata into association properties", async () => {
    const mastraExporter = new LaminarMastraExporter();
    const traceId = "cccccccccccccccccccccccccccccccc";
    const id = "4444444444444444";
    const t0 = new Date();
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_STARTED,
      exportedSpan: {
        id,
        traceId,
        name: "agent.run",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        metadata: {
          sessionId: "sess-123",
          userId: "user-abc",
          customField: "hello",
        },
        tags: ["prod", "weather"],
        isRootSpan: true,
        isEvent: false,
      },
    });
    await mastraExporter.exportTracingEvent({
      type: MastraTracingEventType.SPAN_ENDED,
      exportedSpan: {
        id,
        traceId,
        name: "agent.run",
        type: MastraSpanType.AGENT_RUN,
        startTime: t0,
        endTime: new Date(t0.getTime() + 100),
        metadata: {
          sessionId: "sess-123",
          userId: "user-abc",
          customField: "hello",
        },
        tags: ["prod", "weather"],
        isRootSpan: true,
        isEvent: false,
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const attrs = spans[0].attributes;
    assert.equal(attrs["lmnr.association.properties.session_id"], "sess-123");
    assert.equal(attrs["lmnr.association.properties.user_id"], "user-abc");
    assert.equal(
      attrs["lmnr.association.properties.metadata.customField"],
      "hello",
    );
    assert.deepEqual(attrs["lmnr.association.properties.tags"], [
      "prod",
      "weather",
    ]);
  });

  void it(
    "normalizes AI SDK v5 tool-call / tool-result messages to OpenAI chat format",
    async () => {
      const mastraExporter = new LaminarMastraExporter();
      const traceId = "dddddddddddddddddddddddddddddddd";
      const id = "5555555555555555";
      const t0 = new Date("2026-04-24T10:00:00.000Z");
      const t1 = new Date("2026-04-24T10:00:01.000Z");

      // Multi-step message history as Mastra produces it after one tool round-
      // trip: user → assistant with tool_call → tool result → assistant continues.
      const aiSdkV5Messages = [
        { role: "user", content: [{ type: "text", text: "What's the weather in SF?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool-call",
              toolCallId: "call_123",
              toolName: "weatherLookup",
              input: { location: "SF" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_123",
              toolName: "weatherLookup",
              output: { type: "text", value: "72F and sunny" },
            },
          ],
        },
      ];

      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_STARTED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          isRootSpan: true,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_ENDED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          endTime: t1,
          input: { messages: aiSdkV5Messages },
          output: {
            text: "The weather in SF is 72F and sunny.",
            toolCalls: [],
          },
          attributes: { model: "gpt-4o-mini", provider: "openai.chat" },
          isRootSpan: true,
          isEvent: false,
        },
      });

      const spans = exporter.getFinishedSpans();
      assert.equal(spans.length, 1);
      const attrs = spans[0].attributes;

      const inputStr = attrs["lmnr.span.input"] as string;
      const input = JSON.parse(inputStr);
      assert.ok(Array.isArray(input), "input must be array of messages");

      // Expect exactly 3 messages: user (collapsed to string), assistant (with tool_calls), tool.
      assert.equal(input.length, 3);

      // User message: content collapsed to plain string (OpenAI shape-friendly).
      assert.deepEqual(input[0], {
        role: "user",
        content: "What's the weather in SF?",
      });

      // Assistant message: text preserved as string, tool_calls attached at top level.
      assert.equal(input[1].role, "assistant");
      assert.equal(input[1].content, "Let me check.");
      assert.ok(Array.isArray(input[1].tool_calls));
      assert.equal(input[1].tool_calls.length, 1);
      const tc = input[1].tool_calls[0];
      assert.equal(tc.id, "call_123");
      assert.equal(tc.type, "function");
      assert.equal(tc.function.name, "weatherLookup");
      assert.equal(tc.function.arguments, JSON.stringify({ location: "SF" }));

      // Tool message: split into OpenAI tool message with tool_call_id.
      assert.equal(input[2].role, "tool");
      assert.equal(input[2].tool_call_id, "call_123");
      assert.equal(input[2].content, "72F and sunny");

      // Output: assistant message in OpenAI format.
      const outputStr = attrs["lmnr.span.output"] as string;
      const output = JSON.parse(outputStr);
      assert.ok(Array.isArray(output));
      assert.equal(output.length, 1);
      assert.equal(output[0].role, "assistant");
      assert.equal(output[0].content, "The weather in SF is 72F and sunny.");
    },
  );

  void it(
    "normalizes tool-only assistant output (text null, tool_calls set)",
    async () => {
      const mastraExporter = new LaminarMastraExporter();
      const traceId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const id = "6666666666666666";
      const t0 = new Date("2026-04-24T11:00:00.000Z");
      const t1 = new Date(t0.getTime() + 500);

      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_STARTED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          isRootSpan: true,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_ENDED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          endTime: t1,
          input: { messages: [{ role: "user", content: "Hi" }] },
          output: {
            text: "",
            toolCalls: [
              {
                toolCallId: "call_xyz",
                toolName: "getTime",
                input: { tz: "PST" },
              },
            ],
          },
          isRootSpan: true,
          isEvent: false,
        },
      });

      const spans = exporter.getFinishedSpans();
      const attrs = spans[0].attributes;
      const output = JSON.parse(attrs["lmnr.span.output"] as string);
      assert.equal(output.length, 1);
      assert.equal(output[0].role, "assistant");
      assert.equal(output[0].content, ""); // empty text stays as empty string
      assert.equal(output[0].tool_calls.length, 1);
      assert.equal(output[0].tool_calls[0].function.name, "getTime");
      assert.equal(
        output[0].tool_calls[0].function.arguments,
        JSON.stringify({ tz: "PST" }),
      );
    },
  );

  void it(
    "leaves non-AI-SDK message shapes untouched",
    async () => {
      const mastraExporter = new LaminarMastraExporter();
      const traceId = "ffffffffffffffffffffffffffffffff";
      const id = "7777777777777777";
      const t0 = new Date();

      // Already-OpenAI shape — should pass through unchanged.
      const openAiMessages = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "foo", arguments: '{"x":1}' },
            },
          ],
        },
      ];

      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_STARTED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          isRootSpan: true,
          isEvent: false,
        },
      });
      await mastraExporter.exportTracingEvent({
        type: MastraTracingEventType.SPAN_ENDED,
        exportedSpan: {
          id,
          traceId,
          name: "llm.generate",
          type: MastraSpanType.MODEL_GENERATION,
          startTime: t0,
          endTime: new Date(t0.getTime() + 100),
          input: { messages: openAiMessages },
          isRootSpan: true,
          isEvent: false,
        },
      });

      const spans = exporter.getFinishedSpans();
      const input = JSON.parse(spans[0].attributes["lmnr.span.input"] as string);
      assert.deepEqual(input, openAiMessages);
    },
  );
});
