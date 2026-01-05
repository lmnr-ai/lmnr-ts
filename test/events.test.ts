import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  Laminar,
  observe,
} from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

void describe("events", () => {
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

  void it("sends basic events with custom attributes", () => {
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
    const result = observe({ name: "test" }, fn, 1, 2);

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

  void it("doesn't create a span when Laminar.event is called inside of a span context",
    () => {
      const fn = (a: number, b: number) => {
        Laminar.event({
          name: "test-event-observe",
          attributes: {
            a: "1",
            b: "2",
          },
        });
        return a + b;
      };
      const result = observe({ name: "observe" }, fn, 1, 2);
      const span = Laminar.startActiveSpan({ name: "startActiveSpan" });
      Laminar.event({
        name: "test-event-startActiveSpan",
        attributes: {
          a: "1",
          b: "2",
        },
      });
      span.end();

      assert.strictEqual(result, 3);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 2);
      const observeSpan = spans.find(span => span.name === "observe")!;
      const startActiveSpan = spans.find(span => span.name === "startActiveSpan")!;

      const events = observeSpan.events;
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].name, "test-event-observe");
      assert.strictEqual(events[0].attributes?.['a'], "1");
      assert.strictEqual(events[0].attributes?.['b'], "2");

      const events2 = startActiveSpan.events;
      assert.strictEqual(events2.length, 1);
      assert.strictEqual(events2[0].name, "test-event-startActiveSpan");
      assert.strictEqual(events2[0].attributes?.['a'], "1");
      assert.strictEqual(events2[0].attributes?.['b'], "2");
    });
});
