import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { getRuntime, resetDebugRuntime } from "../src/debug/index";
import { Laminar, observe } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { LaminarContextManager } from "../src/opentelemetry-lib/tracing/context";
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

  void it("returns a LaminarSpan from getCurrentSpan in withSpan", () => {
    const span = Laminar.startSpan({ name: "test" });
    Laminar.withSpan(span, () => {
      const currentSpan = Laminar.getCurrentSpan();
      assert.strict(currentSpan instanceof LaminarSpan);
    });
    span.end();
  });

  void it("returns a LaminarSpan from getCurrentSpan in observe", () => {
    observe({ name: "test" }, () => {
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

  void it("stamps global metadata on spans built without observe / startActiveSpan", () => {
    // Mirrors a pure auto-instrumentation trace: no observe / startActiveSpan,
    // so no association properties are on the OTEL context. Global metadata
    // (e.g. a debug run's rollout.session_id) must still land on the span.
    LaminarContextManager.setGlobalMetadata({ "rollout.session_id": "abc" });
    try {
      const span = Laminar.startSpan({ name: "auto" });
      span.end();
      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(
        spans[0].attributes['lmnr.association.properties.metadata.rollout.session_id'],
        "abc",
      );
    } finally {
      LaminarContextManager.setGlobalMetadata({});
    }
  });

  void it("arming from a propagated debug block syncs rollout.session_id to metadata", () => {
    // A downstream run arms its debug runtime from the parent span context's
    // debug block during span creation (after initialize()). That path must
    // re-sync LaminarContextManager.getGlobalMetadata() so auto-instrumentation
    // spans (which read global metadata in LaminarSpanProcessor.onStart) still
    // pick up rollout.session_id — not just spans started via _startSpan.
    const SESSION = "00000000-0000-0000-0000-0000000000aa";
    resetDebugRuntime();
    LaminarContextManager.setGlobalMetadata({});
    try {
      const parent = Laminar.startSpan({
        name: "downstream",
        parentSpanContext: {
          traceId: "01234567-89ab-cdef-0123-456789abcdef",
          spanId: "0123456789abcdef",
          debug: { enabled: true, sessionId: SESSION },
        },
      });
      parent.end();
      assert.ok(getRuntime() !== null);
      assert.strictEqual(
        LaminarContextManager.getGlobalMetadata()["rollout.session_id"],
        SESSION,
      );
    } finally {
      resetDebugRuntime();
      LaminarContextManager.setGlobalMetadata({});
    }
  });
});
