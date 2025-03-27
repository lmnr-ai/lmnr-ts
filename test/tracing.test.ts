import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, Span, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
  Laminar,
  LaminarAttributes,
  observe,
  TracingLevel,
  withLabels,
  withTracingLevel,
} from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/sdk/configuration";

void describe("tracing", () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ processor, exporter });
  });


  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await processor.shutdown();
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

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].spanContext().traceId, "0123456789abcdef0123456789abcdef");
    assert.strictEqual(spans[0].parentSpanId, "0123456789abcdef");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
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
    assert.strictEqual(spans[0].parentSpanId, "0123456789abcdef");

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

    assert.strictEqual(doubleSpan?.parentSpanId, testSpan?.spanContext().spanId);
    assert.strictEqual(testSpan?.spanContext().traceId, doubleSpan?.spanContext().traceId);
    assert.strictEqual(testSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.strictEqual(doubleSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the labels on wrapped functions", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await withLabels(
      ["endpoint", "some-endpoint"],
      async (a, b) => await observe({ name: "inner" }, fn, a, b),
      1, 2,
    );

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.deepEqual(
      (spans[0].attributes['lmnr.association.properties.labels'] as string[]).sort(),
      ["some-endpoint", "endpoint"].sort(),
    );

    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["inner"]);
  });

  void it("sets the labels on startSpan", () => {
    const span = Laminar.startSpan({ name: "test", labels: ["endpoint", "some-endpoint"] });
    const result = Laminar.withSpan(span, () => 3, true);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.deepEqual(
      (spans[0].attributes['lmnr.association.properties.labels'] as string[]).sort(),
      ["some-endpoint", "endpoint"].sort(),
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("doesn't set the labels on the current span", async () => {
    const fn = (a: number, b: number) => withLabels(["endpoint", "some-endpoint"], () => a + b);
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(
      spans[0].attributes['lmnr.association.properties.labels'],
      undefined,
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.deepEqual(spans[0].attributes['lmnr.span.path'], ["test"]);
  });

  void it("sets the labels on nested functions", async () => {
    const double = (a: number) => a * 2;
    const fn = async (a: number, b: number) => a + await observe({ name: "double" }, double, b);
    const result = await withLabels(
      ["endpoint", "some-endpoint"],
      async (a, b) => await observe({ name: "test" }, fn, a, b),
      1, 2,
    );

    assert.strictEqual(result, 5);


    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const testSpan = spans.find(span => span.name === "test");
    const doubleSpan = spans.find(span => span.name === "double");

    assert.strictEqual(testSpan?.attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(testSpan?.attributes['lmnr.span.output'], "5");
    assert.deepEqual(
      (testSpan?.attributes['lmnr.association.properties.labels'] as string[]).sort(),
      ["some-endpoint", "endpoint"].sort(),
    );

    assert.strictEqual(doubleSpan?.attributes['lmnr.span.input'], JSON.stringify([2]));
    assert.strictEqual(doubleSpan?.attributes['lmnr.span.output'], "4");
    assert.deepEqual(
      (doubleSpan?.attributes['lmnr.association.properties.labels'] as string[]).sort(),
      ["some-endpoint", "endpoint"].sort(),
    );

    assert.strictEqual(doubleSpan?.parentSpanId, testSpan?.spanContext().spanId);
    assert.strictEqual(testSpan?.spanContext().traceId, doubleSpan?.spanContext().traceId);
    assert.strictEqual(doubleSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.strictEqual(testSpan?.attributes['lmnr.span.instrumentation_source'], "javascript");
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

  void it("sets the session id attribute when withSession is used", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await Laminar.withSession(
      "123",
      async () => await observe({ name: "test" }, fn, 1, 2),
    );

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();

    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].name, "test");

    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the session id on the current span when withSession is used", async () => {
    const fn = (a: number, b: number) =>
      Laminar.withSession("123", () => a + b);
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the metadata on the current span when withMetadata is used", async () => {
    const fn = (a: number, b: number) =>
      Laminar.withMetadata(
        { my_metadata_key: "my_metadata_value" },
        () => a + b,
      );
    const result = await observe({ name: "test" }, fn, 1, 2);

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].attributes['lmnr.association.properties.metadata.my_metadata_key'],
      "my_metadata_value",
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
  });

  void it("sets the metadata when withMetadata is used", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await Laminar.withMetadata(
      { my_metadata_key: "my_metadata_value" },
      async () => await observe({ name: "test" }, fn, 1, 2),
    );

    assert.strictEqual(result, 3);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].attributes['lmnr.association.properties.metadata.my_metadata_key'],
      "my_metadata_value",
    );
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
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
});
