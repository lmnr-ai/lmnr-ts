import { afterEach, after, beforeEach, describe, it } from "node:test";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  observe,
} from "../src/index";
import assert from "node:assert/strict";
import { initializeTracing } from "../src/sdk/configuration";
import { context, trace } from "@opentelemetry/api";
import { _resetConfiguration } from "../src/sdk/configuration";

const isThenable = <T = unknown>(
  promise: Promise<T> | T
): promise is Promise<T> =>
  promise !== null
    && typeof promise === 'object'
    && 'then' in promise
    && typeof promise.then === 'function'

// trying to make this close to
// https://github.com/vercel/next.js/blob/790efc5941e41c32bb50cd915121209040ea432c/packages/next/src/server/lib/trace/tracer.ts#L297
const startNextJsSpan = (innerFn: (...args: any[]) => any, ...args: any[]) => {
  const options = {
    attributes: {
      'next.span_name': 'test',
      'next.span_type': 'NextNodeServer.findPageComponents'
    }
  }
  return context.with(context.active(), () => {
    trace
      .getTracer('next.js', '0.0.1')
      .startActiveSpan('test_next_js', options, (span) => {
        const result = innerFn(...args);
        if (isThenable(result)) {
          result.then(() => span.end());
        } else {
          span.end();
        }
      });
  });
}

describe("nextjs", () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ processor, exporter });
  });

  afterEach(() => {
    exporter.reset();
  });

  after(() => {
    processor.shutdown();
    trace.disable();
    context.disable();
  });

  it("doesn't send any spans if the span is Next.js", async () => {
    const fn = (a: number, b: number) => a + b;
    startNextJsSpan(fn, 1, 2);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 0);
  });

  it("doesn't send any spans when all nested spans are Next.js", async () => {
    const fn = (a: number, b: number) => a + b;
    const outer = () => startNextJsSpan(fn, 1, 2);
    startNextJsSpan(outer);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 0);
  });

  it("sends the inner span if it is not Next.js", async () => {
    const fn = (a: number, b: number) => a + b;
    const observed = async () => await observe({name: "test"}, fn, 1, 2);
    startNextJsSpan(observed);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
    assert.strictEqual(spans[0].attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(spans[0].attributes['lmnr.span.output'], "3");

    assert.strictEqual(spans[0].attributes['lmnr.association.properties.label.endpoint'], undefined);
    assert.strictEqual(spans[0].attributes['lmnr.span.instrumentation_source'], "javascript");
    assert.strictEqual(spans[0].attributes['lmnr.internal.override_parent_span'], true);
  });
});

describe("nextjs.preserveNextJsSpans", () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ processor, exporter, preserveNextJsSpans: true });
  });

  afterEach(() => {
    exporter.reset();
  });

  after(() => {
    processor.shutdown();
    trace.disable();
    context.disable();
  });

  it("preserves the Next.js span", async () => {
    const fn = (a: number, b: number) => a + b;
    startNextJsSpan(fn, 1, 2);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test_next_js");
  });

  it("preserves the Next.js span and its children", async () => {
    const fn = (a: number, b: number) => a + b;
    const inner = observe({name: "test"}, fn, 1, 2);
    const outer = () => startNextJsSpan(async () => await inner);
    startNextJsSpan(outer);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const nextJsSpan = spans.find(span => span.name === "test_next_js");
    const observedSpan = spans.find(span => span.name === "test");
    assert.strictEqual(observedSpan?.attributes['lmnr.span.input'], JSON.stringify([1, 2]));
    assert.strictEqual(observedSpan?.attributes['lmnr.span.output'], "3");
  });
});
