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

  void it("manuallyInstrument wraps the Mastra constructor and injects the exporter", () => {
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
    const exporters =
      instance.receivedConfig?.observability?.configs?.default?.exporters;
    assert.ok(Array.isArray(exporters), "exporters should be injected");
    assert.ok(
      exporters.some((e: any) => e instanceof LaminarMastraExporter),
      "LaminarMastraExporter should be present in the exporters list",
    );
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
});
