import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

import { observe } from "../src";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { MastraExporter } from "../src/opentelemetry-lib/instrumentation/mastra/exporter";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

// Minimal Mastra span shape — matches the narrow interface inside exporter.ts.
const makeMastraSpan = (overrides: Record<string, unknown>) => ({
  id: "0000000000000001",
  traceId: "00000000000000000000000000000001",
  name: "agent run",
  type: "agent_run",
  startTime: new Date(Date.now() - 10),
  endTime: new Date(),
  isEvent: false,
  isRootSpan: true,
  ...overrides,
});

/**
 * Build a `MastraExporter` whose internal OTLP exporter is swapped for an
 * in-memory one, so we can assert what spans it emits without any network.
 */
const makeTestExporter = (opts: { linkToActiveContext?: boolean } = {}) => {
  const inMemory = new InMemorySpanExporter();
  const mastra = new MastraExporter({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1",
    disableBatch: true,
    realtime: true,
    linkToActiveContext: opts.linkToActiveContext,
  });
  mastra.init({ config: { serviceName: "test" } });
  // Replace the internal processor with one pointed at our in-memory exporter
  // as soon as the exporter finishes its first lazy setup.
  const privateMastra = mastra as unknown as {
    processor?: {
      onEnd(span: ReadableSpan): void;
      forceFlush(): Promise<void>;
      shutdown(): Promise<void>;
    };
    otlpExporter?: SpanExporter;
    isSetup: boolean;
  };
  privateMastra.processor = new SimpleSpanProcessor(inMemory);
  privateMastra.otlpExporter = inMemory;
  privateMastra.isSetup = true;
  return { mastra, inMemory };
};

void describe("MastraExporter — OTel context linking", () => {
  const initExporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter: initExporter, disableBatch: true });
  });

  void afterEach(() => {
    initExporter.reset();
  });

  void after(async () => {
    await initExporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("reparents Mastra spans under the active observe() span", async () => {
    const { mastra, inMemory } = makeTestExporter();

    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;

    await observe({ name: "outer" }, async () => {
      const active = trace.getActiveSpan();
      const ctx = active?.spanContext();
      parentTraceId = ctx?.traceId;
      parentSpanId = ctx?.spanId;

      // Simulate Mastra firing a root span_started + span_ended event inside
      // the active observe() context.
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = inMemory.getFinishedSpans();
    assert.strictEqual(spans.length, 1, "expected exactly one Mastra span");
    const s = spans[0];
    assert.strictEqual(
      s.spanContext().traceId,
      parentTraceId,
      "Mastra span should adopt the observe() trace id",
    );
    assert.strictEqual(
      getParentSpanId(s),
      parentSpanId,
      "Mastra root should be parented to the observe() span",
    );
  });

  void it("descendant Mastra spans stay on the rewritten trace id", async () => {
    const { mastra, inMemory } = makeTestExporter();

    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;

    await observe({ name: "outer" }, async () => {
      const ctx = trace.getActiveSpan()?.spanContext();
      parentTraceId = ctx?.traceId;
      parentSpanId = ctx?.spanId;

      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "2222222222222222",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: "1111111111111111",
          type: "model_generation",
          name: "llm: 'gpt-4o-mini'",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "2222222222222222",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: "1111111111111111",
          type: "model_generation",
          name: "llm: 'gpt-4o-mini'",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = inMemory.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const traceIds = [...new Set(spans.map((s) => s.spanContext().traceId))];
    assert.strictEqual(traceIds.length, 1, "all Mastra spans share one trace");
    assert.strictEqual(traceIds[0], parentTraceId);

    const root = spans.find((s) => s.name === "agent run")!;
    const child = spans.find((s) => s.name === "llm: 'gpt-4o-mini'")!;
    assert.strictEqual(getParentSpanId(root), parentSpanId);
    // Child's parent must still resolve to the root's span id (in normalized
    // 16-char lowercase hex form emitted by the exporter).
    assert.strictEqual(getParentSpanId(child), root.spanContext().spanId);
  });

  void it("does not reparent when linkToActiveContext is false", async () => {
    const { mastra, inMemory } = makeTestExporter({ linkToActiveContext: false });

    await observe({ name: "outer" }, async () => {
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "3333333333333333",
          traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "3333333333333333",
          traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = inMemory.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "trace id should be preserved when linking is disabled",
    );
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });

  void it("keeps the original trace id when no observe() is active", async () => {
    const { mastra, inMemory } = makeTestExporter();

    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: "4444444444444444",
        traceId: "cccccccccccccccccccccccccccccccc",
        parentSpanId: undefined,
        type: "agent_run",
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: "4444444444444444",
        traceId: "cccccccccccccccccccccccccccccccc",
        parentSpanId: undefined,
        type: "agent_run",
      }),
    });

    const spans = inMemory.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      "cccccccccccccccccccccccccccccccc",
    );
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });
});
