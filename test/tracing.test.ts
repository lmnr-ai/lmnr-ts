import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, Span, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  Laminar,
  LaminarAttributes,
  observe,
  TracingLevel,
  withTracingLevel,
} from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

void describe("tracing", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    // This is a hack to make Laminar.initialized() return true for testing
    // purposes.
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

  void it("observes a wrapped function", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({ name: "test" }, fn, 1, 2);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");

    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("observes using withSpan", () => {
    const fn = (a: number, b: number) => a + b;
    const span = Laminar.startSpan({ name: "test", input: "my_input" });
    const result = Laminar.withSpan(
      span,
      () => {
        const result = fn(1, 2);
        Laminar.setSpanOutput(result);
        return result;
      },
      true,
    );

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify("my_input"));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("observes a wrapped async function", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const fn = async (a: number, b: number) => a + b;
    const result = await observe({ name: "test" }, fn, 1, 2);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("observes using withSpan with async functions", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const fn = async (a: number, b: number) => a + b;
    const span = Laminar.startSpan({ name: "test", input: "my_input" });
    const result = await Laminar.withSpan(
      span,
      async () => {
        const result = await fn(1, 2);
        Laminar.setSpanOutput(result);
        return result;
      },
      true,
    );

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify("my_input"));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets span name to function name if not provided to observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({}, fn, 1, 2);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "fn");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["fn"]);
  });

  void it("sets span type to LLM when spanType is LLM in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({ name: "test", spanType: "LLM" }, fn, 1, 2);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.type'], 'LLM');

    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets span type to LLM when spanType is LLM in startSpan", () => {
    const span = Laminar.startSpan({ name: "test", spanType: "LLM" });
    const result = Laminar.withSpan(span, () => 3, true);
    span.end();

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.type'], 'LLM');
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the parent span context in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe(
      {
        name: "test",
        parentSpanContext: {
          traceId: "01234567-89ab-cdef-0123-456789abcdef",
          spanId: "00000000-0000-0000-0123-456789abcdef",
          isRemote: false,
        },
      },
      fn,
      1, 2,
    );

    const result2 = await observe(
      {
        name: "test2",
      },
      fn,
      1, 2,
    );

    assert.strictEqual(result, 3);
    assert.strictEqual(result2, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test");
    const test2Span = spans.find(span => span.name === "test2");

    assert.strictEqual(testSpan?.attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(testSpan?.attributes['lmnr.span.output'], "3");
    assert.strictEqual(testSpan?.name, "test");

    assert.strictEqual(testSpan?.spanContext().traceId, "0123456789abcdef0123456789abcdef");
    assert.strictEqual(getParentSpanId(testSpan), "0123456789abcdef");
    assert.strictEqual(testSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(testSpan?.attributes['lmnr.span.path'], ["test"]);

    assert.notStrictEqual(testSpan?.spanContext().traceId, test2Span?.spanContext().traceId);
    assert.notStrictEqual(getParentSpanId(test2Span!), getParentSpanId(testSpan));
    assert.strictEqual(getParentSpanId(test2Span!), undefined);
  });

  void it("sets the parent span context in startSpan", () => {
    const span = Laminar.startSpan({
      name: "test",
      parentSpanContext: {
        traceId: "01234567-89ab-cdef-0123-456789abcdef",
        spanId: "00000000-0000-0000-0123-456789abcdef",
        isRemote: false,
      },
    });
    const result = Laminar.withSpan(span, () => 3, true);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].spanContext().traceId, "0123456789abcdef0123456789abcdef");
    assert.strictEqual(getParentSpanId(spans[0]), "0123456789abcdef");

    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the session id in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({ name: "test", sessionId: "123" }, fn, 1, 2);

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the user id in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({ name: "test", userId: "123" }, fn, 1, 2);

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].attributes['lmnr.association.properties.user_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the metadata in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({
      name: "test",
      metadata: { key: "value", nested: { key2: "value2" } },
    }, fn, 1, 2);

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].attributes['lmnr.association.properties.metadata.key'], "value");
    assert.deepStrictEqual(
      JSON.parse(spans[0].attributes['lmnr.association.properties.metadata.nested'] as string),
      { key2: "value2" },
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the tags in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({
      name: "test",
      tags: ["tag1", "tag2"],
    }, fn, 1, 2);

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.deepStrictEqual(
      spans[0].attributes['lmnr.association.properties.tags'],
      ["tag1", "tag2"],
    );
    assert.strictEqual(
      spans[0].attributes['lmnr.span.instrumentation_source'],
      "javascript",
    );
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("removes duplicate tags in observe", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await observe({
      name: "test",
      tags: ["tag1", "tag2", "tag1"],
    }, fn, 1, 2);

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    const tags = spans[0].attributes['lmnr.association.properties.tags'] as string[];
    assert.strictEqual(tags.length, 2);
    assert.strictEqual(tags.includes("tag1"), true);
    assert.strictEqual(tags.includes("tag2"), true);
    assert.strictEqual(
      spans[0].attributes['lmnr.span.instrumentation_source'],
      "javascript",
    );
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the session id in startSpan", () => {
    const span = Laminar.startSpan({ name: "test", sessionId: "123" });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the user id in startSpan", () => {
    const span = Laminar.startSpan({ name: "test", userId: "123" });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.user_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the metadata in startSpan", () => {
    const span = Laminar.startSpan({
      name: "test",
      metadata: { key: "value", nested: { key2: "value2" } },
    });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.metadata.key'], "value");
    assert.deepStrictEqual(
      JSON.parse(spans[0].attributes['lmnr.association.properties.metadata.nested'] as string),
      { key2: "value2" },
    );
  });

  void it("sets the tags in startSpan", () => {
    const span = Laminar.startSpan({ name: "test", tags: ["tag1", "tag2"] });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.deepStrictEqual(
      spans[0].attributes['lmnr.association.properties.tags'],
      ["tag1", "tag2"],
    );
    assert.strictEqual(
      spans[0].attributes['lmnr.span.instrumentation_source'],
      "javascript",
    );
  });

  void it("removes duplicate tags in startSpan", () => {
    const span = Laminar.startSpan({ name: "test", tags: ["tag1", "tag2", "tag1"] });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    const tags = spans[0].attributes['lmnr.association.properties.tags'] as string[];
    assert.strictEqual(tags.length, 2);
    assert.strictEqual(tags.includes("tag1"), true);
    assert.strictEqual(tags.includes("tag2"), true);
  });

  void it("can process empty metadata or tags", () => {
    const span = Laminar.startSpan({
      name: "test", metadata: {}, tags: [], userId: "", sessionId: "",
    });
    const result = Laminar.withSpan(span, () => 3, true);
    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.user_id'], undefined);
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], undefined);
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.metadata'], undefined);
    assert.deepStrictEqual(spans[0].attributes['lmnr.association.properties.tags'], []);
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("observes nested functions", async () => {
    const double = (a: number) => a * 2;
    const fn = async (a: number, b: number) => a + await observe({ name: "double" }, double, b);
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 5);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test");
    const doubleSpan = spans.find(span => span.name === "double");

    assert.strictEqual(testSpan?.attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(testSpan?.attributes['lmnr.span.output'], "5");
    assert.deepEqual(testSpan?.attributes['lmnr.span.path'], ["test"]);

    assert.strictEqual(doubleSpan?.attributes['lmnr.span.input'], JSON.stringify([2]));
    assert.strictEqual(doubleSpan?.attributes['lmnr.span.output'], "4");
    assert.deepEqual(doubleSpan?.attributes['lmnr.span.path'], ["test", "double"]);

    assert.strictEqual(getParentSpanId(doubleSpan), testSpan?.spanContext().spanId);
    assert.strictEqual(testSpan?.spanContext().traceId, doubleSpan?.spanContext().traceId);
    assert.strictEqual(testSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.strictEqual(doubleSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the span path on manual spans within observe", async () => {
    const double = (a: number, span: Span) =>
      Laminar.withSpan(span, () => a * 2, true);
    const fn = (a: number, b: number) => {
      const span = Laminar.startSpan({ name: "inner" });
      return a + (double(b, span) as number);
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 5);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test");
    const innerSpan = spans.find(span => span.name === "inner");
    assert.deepEqual(testSpan?.attributes['lmnr.span.path'], ["test"]);
    assert.deepEqual(innerSpan?.attributes['lmnr.span.path'], ["test", "inner"]);
  });

  void it("sets the span path on observed spans within manual spans", async () => {
    const double = async (a: number) =>
      await observe({ name: "inner" }, (n) => n * 2, a);
    const fn = async (a: number, b: number) => {
      const span = Laminar.startSpan({ name: "test" });
      return a + (await Laminar.withSpan(span, () => double(b), true));
    };
    const result = await fn(1, 2);

    assert.strictEqual(result, 5);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test");
    const innerSpan = spans.find(span => span.name === "inner");
    assert.deepEqual(testSpan?.attributes['lmnr.span.path'], ["test"]);
    assert.deepEqual(innerSpan?.attributes['lmnr.span.path'], ["test", "inner"]);

    assert.strictEqual(testSpan?.spanContext().traceId, innerSpan?.spanContext().traceId);
    assert.strictEqual(getParentSpanId(innerSpan), testSpan?.spanContext().spanId);
  });

  void it("sets the tracing level attribute when withTracingLevel is used", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await withTracingLevel(
      TracingLevel.META_ONLY,
      async (a, b) => await observe({ name: "span_with_meta_only" }, fn, a, b),
      1, 2,
    );

    const result2 = await withTracingLevel(
      TracingLevel.OFF,
      async (a, b) => await observe({ name: "span_with_off" }, fn, a, b),
      1, 2,
    );

    assert.strictEqual(result, 3);
    assert.strictEqual(result2, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);

    const spanWithMetaOnly = spans.find(span => span.name === "span_with_meta_only");
    const spanWithOff = spans.find(span => span.name === "span_with_off");

    assert.strictEqual(spanWithMetaOnly?.attributes['lmnr.internal.tracing_level'], "meta_only");
    assert.strictEqual(
      spanWithMetaOnly?.attributes['lmnr.span.instrumentation_source'],
      "javascript",
    );

    assert.strictEqual(spanWithOff?.attributes['lmnr.internal.tracing_level'], "off");
    assert.strictEqual(spanWithOff?.attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the attributes with setSpanAttributes", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setSpanAttributes({
        [LaminarAttributes.PROVIDER]: "openai",
        [LaminarAttributes.REQUEST_MODEL]: "gpt-4o-date-version",
        [LaminarAttributes.RESPONSE_MODEL]: "gpt-4o",
        [LaminarAttributes.INPUT_TOKEN_COUNT]: 100,
        [LaminarAttributes.OUTPUT_TOKEN_COUNT]: 200,
      });

      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");

    assert.strictEqual(spans[0].attributes['gen_ai.system'], "openai");
    assert.strictEqual(spans[0].attributes['gen_ai.request.model'], "gpt-4o-date-version");
    assert.strictEqual(spans[0].attributes['gen_ai.response.model'], "gpt-4o");
    assert.strictEqual(spans[0].attributes['gen_ai.usage.input_tokens'], 100);
    assert.strictEqual(spans[0].attributes['gen_ai.usage.output_tokens'], 200);

    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("processes exceptions in observe", async () => {
    const fn = () => {
      throw new Error("test err");
    };
    await assert.rejects(
      async () => await observe({ name: "test" }, fn),
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");

    const events = spans[0].events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].name, "exception");
    assert.strictEqual(events[0].attributes?.['exception.type'], "Error");
    assert.strictEqual(events[0].attributes?.['exception.message'], "test err");
    assert.strictEqual(
      events[0]
        .attributes
        ?.['exception.stacktrace']
        ?.toString()
        .startsWith('Error: test err\n    at'),
      true,
    );
  });

  void it("processes exceptions in withSpan", async () => {
    const span = Laminar.startSpan({ name: "test" });
    const fn = () => {
      throw new Error("test error");
    };
    await assert.rejects(
      async () => await Laminar.withSpan(span, fn, true),
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");

    const events = spans[0].events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].name, "exception");
    assert.strictEqual(events[0].attributes?.['exception.type'], "Error");
    assert.strictEqual(events[0].attributes?.['exception.message'], "test error");
    assert.strictEqual(
      events[0]
        .attributes
        ?.['exception.stacktrace']
        ?.toString()
        .startsWith('Error: test error\n    at'),
      true,
    );
  });

  void it("sets the session id on the current span when setTraceSessionId is used", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setTraceSessionId("123");
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
  });

  void it("sets the user id on the current span when setTraceUserId is used", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setTraceUserId("123");
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.user_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
  });

  void it("sets metadata on the current span when setTraceMetadata is used", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setTraceMetadata({
        k1: "v1", k2: {
          obj: "shall be stringified",
        },
      });
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.metadata.k1'], "v1");
    assert.strictEqual(
      spans[0].attributes['lmnr.association.properties.metadata.k2'],
      JSON.stringify({ obj: "shall be stringified" }),
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
  });

  void it("sets tags on the current span when setSpanTags is used", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setSpanTags(["tag1", "tag2"]);
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.deepStrictEqual(
      spans[0].attributes['lmnr.association.properties.tags'], ["tag1", "tag2"],
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
  });

  void it("deduplicates tags on the current span when setSpanTags is used", async () => {
    const fn = (a: number, b: number) => {
      Laminar.setSpanTags(["tag1", "tag2", "tag1"]);
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    const tags = spans[0].attributes['lmnr.association.properties.tags'] as string[];
    assert.strictEqual(tags.length, 2);
    assert.strictEqual(tags.includes("tag1"), true);
    assert.strictEqual(tags.includes("tag2"), true);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
  });

  void it("does not override span type in nested observe", async () => {
    const fn = (a: number, b: number) => a + b;

    await observe(
      { name: "evaluator", spanType: 'EVALUATOR' },
      async () => await observe({ name: 'default' }, fn, 1, 2),
      1,
      2,
    );

    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 2);
    const evaluatorSpan = spans.find((s) => s.name === 'evaluator');
    const defaultSpan = spans.find((s) => s.name === 'default');

    assert.ok(evaluatorSpan, "evaluator span should be present");
    assert.ok(defaultSpan, "default span should be present");

    assert.strictEqual(evaluatorSpan?.attributes['lmnr.span.type'], 'EVALUATOR');
    assert.strictEqual(defaultSpan?.attributes['lmnr.span.type'], undefined);
  });

  void it("sends basic events with custom attributes", async () => {
    const fn = (a: number, b: number) => {
      Laminar.event({
        name: "test-event",
        attributes: {
          a: "1",
          b: "2",
        },
      });
      return a + b;
    };
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");

    const events = spans[0].events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].name, "test-event");
    assert.strictEqual(events[0].attributes?.['a'], "1");
    assert.strictEqual(events[0].attributes?.['b'], "2");
  });

  void it("creates a span when Laminar.event is called outside of a span context", () => {
    const fn = (a: number, b: number) => {
      Laminar.event({
        name: "test-event",
        attributes: {
          a: "1",
          b: "2",
        },
      });
      return a + b;
    };
    const result = fn(1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test-event");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");

    const events = spans[0].events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].name, "test-event");
    assert.strictEqual(events[0].attributes?.['a'], "1");
    assert.strictEqual(events[0].attributes?.['b'], "2");
  });

  void it("sends events with session and user id attributes", () => {
    const fn = (a: number, b: number) => {
      Laminar.event({
        name: "test-event",
        attributes: {
          a: "1",
          b: "2",
        },
        sessionId: "123",
        userId: "456",
      });
      return a + b;
    };
    const result = fn(1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test-event");

    const events = spans[0].events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].name, "test-event");
    assert.strictEqual(events[0].attributes?.['a'], "1");
    assert.strictEqual(events[0].attributes?.['b'], "2");
    assert.strictEqual(events[0].attributes?.['lmnr.event.session_id'], "123");
    assert.strictEqual(events[0].attributes?.['lmnr.event.user_id'], "456");
  });

  void it("nests spans in startSpan", () => {
    const testSpanManual = Laminar.startSpan({ name: "test" });
    const innerSpanManual = Laminar.startSpan({ name: "inner" });
    innerSpanManual.end();
    testSpanManual.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test")!;
    const innerSpan = spans.find(span => span.name === "inner")!;
    assert.strictEqual(testSpan.spanContext().traceId, innerSpan.spanContext().traceId);
    assert.strictEqual(getParentSpanId(innerSpan), testSpan.spanContext().spanId);
  });

  void it("nests observed span in startSpan", async () => {
    const testSpanManual = Laminar.startSpan({ name: "test" });
    await observe({ name: "inner" }, () => {
      return;
    });
    testSpanManual.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test")!;
    const innerSpan = spans.find(span => span.name === "inner")!;
    assert.strictEqual(testSpan.spanContext().traceId, innerSpan.spanContext().traceId);
    assert.strictEqual(getParentSpanId(innerSpan), testSpan.spanContext().spanId);
  });

  void it("is backwards compatible with Laminar.withSpan", async () => {
    const testSpanManual = Laminar.startSpan({ name: "test" });
    await Laminar.withSpan(testSpanManual, async () => {
      await observe({ name: "other" }, () => {
        return;
      });
    });
    await Laminar.withSpan(testSpanManual, async () => {
      await observe({ name: "middle" }, async () => {
        await observe({ name: "inner" }, () => {
          return;
        });
      });
    });
    testSpanManual.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 4);
    const testSpan = spans.find(span => span.name === "test")!;
    const otherSpan = spans.find(span => span.name === "other")!;
    const middleSpan = spans.find(span => span.name === "middle")!;
    const innerSpan = spans.find(span => span.name === "inner")!;
    assert.strictEqual(testSpan.spanContext().traceId, otherSpan.spanContext().traceId);
    assert.strictEqual(testSpan.spanContext().traceId, middleSpan.spanContext().traceId);
    assert.strictEqual(testSpan.spanContext().traceId, innerSpan.spanContext().traceId);
    assert.strictEqual(getParentSpanId(otherSpan), testSpan.spanContext().spanId);
    assert.strictEqual(getParentSpanId(middleSpan), testSpan.spanContext().spanId);
    assert.strictEqual(getParentSpanId(innerSpan), middleSpan.spanContext().spanId);
  });
});
