import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar, observe } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { LaminarSpan } from "../src/opentelemetry-lib/tracing/span";


void describe("span interface tests", () => {
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

  void it("returns a LaminarSpan from startSpan", () => {
    const span = Laminar.startSpan({ name: "test" });
    assert.strict(span instanceof LaminarSpan);
    span.end();
  });

  void it("returns a LaminarSpan from startActiveSpan", () => {
    const span = Laminar.startActiveSpan({ name: "test" });
    assert.strict(span instanceof LaminarSpan);
    span.end();
  });

  void it("returns a LaminarSpan from getCurrentSpan in withSpan", async () => {
    const span = Laminar.startSpan({ name: "test" });
    await Laminar.withSpan(span, () => {
      const currentSpan = Laminar.getCurrentSpan();
      assert.strict(currentSpan instanceof LaminarSpan);
    });
    span.end();
  });

  void it("returns a LaminarSpan from getCurrentSpan in observe", async () => {
    await observe({ name: "test" }, () => {
      const currentSpan = Laminar.getCurrentSpan();
      assert.strict(currentSpan instanceof LaminarSpan);
    });
  });

  void it("allows endint a span returned by getCurrentSpan", () => {
    Laminar.startActiveSpan({ name: "test" });
    const currentSpan = Laminar.getCurrentSpan();
    currentSpan?.end();
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "test");
  });

  void it("correctly sets span input, output, tags, metadata, session id, user id", () => {
    Laminar.startActiveSpan({ name: "test" });
    const span = Laminar.getCurrentSpan() as LaminarSpan;
    span.setInput("my_input");
    span.setOutput("my_output");
    span.setTags(["tag1", "tag2"]);
    span.setTraceMetadata({ key: "value" });
    span.setTraceSessionId("123");
    span.setTraceUserId("456");
    assert.strictEqual(span?.attributes['lmnr.span.input'], "my_input");
    assert.strictEqual(span?.attributes['lmnr.span.output'], "my_output");
    assert.deepStrictEqual(span?.attributes['lmnr.association.properties.tags'], ["tag1", "tag2"]);
    assert.strictEqual(span?.attributes['lmnr.association.properties.metadata.key'], "value");
    assert.strictEqual(span?.attributes['lmnr.association.properties.session_id'], "123");
    assert.strictEqual(span?.attributes['lmnr.association.properties.user_id'], "456");
  });
});
