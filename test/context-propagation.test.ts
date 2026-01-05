import assert from "node:assert";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { Laminar, observe } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

const COMMON_ASSOCIATION_PROPERTIES = {
  metadata: { key: "value" },
  sessionId: "session1",
  userId: "user1",
  spanType: "EVALUATION" as any,
};

function assertAssociationPropertiesPropagated(
  parentSpan: ReadableSpan,
  childSpan: ReadableSpan,
) {
  assert.strictEqual(parentSpan.spanContext().traceId, childSpan.spanContext().traceId);
  assert.strictEqual(getParentSpanId(childSpan), parentSpan.spanContext().spanId);

  assert.strictEqual(
    parentSpan.attributes['lmnr.association.properties.metadata.key'],
    "value",
  );
  assert.strictEqual(
    childSpan.attributes['lmnr.association.properties.metadata.key'],
    "value",
  );

  assert.strictEqual(
    parentSpan.attributes['lmnr.association.properties.session_id'],
    "session1",
  );
  assert.strictEqual(
    childSpan.attributes['lmnr.association.properties.session_id'],
    "session1",
  );

  assert.strictEqual(
    parentSpan.attributes['lmnr.association.properties.user_id'],
    "user1",
  );
  assert.strictEqual(
    childSpan.attributes['lmnr.association.properties.user_id'],
    "user1",
  );

  assert.strictEqual(
    parentSpan.attributes['lmnr.association.properties.trace_type'],
    "EVALUATION",
  );
  assert.strictEqual(
    childSpan.attributes['lmnr.association.properties.trace_type'],
    "EVALUATION",
  );
}

void describe("global metadata", () => {
  const exporter = new InMemorySpanExporter();
  void beforeEach(() => {
    _resetConfiguration();
    // This hack allows calling Laminar.initialize() and the tracing double
    // initialization is prevented by the _configuration global variable
    // inside initializeTracing()
    initializeTracing({ exporter, disableBatch: true });
  });
  void afterEach(async () => {
    exporter.reset();
    await Laminar.shutdown();
  });
  void after(async () => {
    await exporter.shutdown();
  });
  void it("propagates the global metadata to observe decorator", () => {
    Laminar.initialize({
      projectApiKey: "test",
      metadata: { key: "value" },
    });
    const result = observe({ name: "test" }, () => 3);
    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes['lmnr.association.properties.metadata.key'], "value");
  });

  void it("propagates the global metadata to startSpan", () => {
    Laminar.initialize({
      projectApiKey: "test",
      metadata: { key: "value" },
    });
    const spanHandle = Laminar.startSpan({ name: "test" });
    spanHandle.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.attributes['lmnr.association.properties.metadata.key'], "value");
  });
});

void describe("association properties", () => {
  const exporter = new InMemorySpanExporter();
  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });
  void afterEach(() => {
    exporter.reset();
  });
  void after(async () => {
    await exporter.shutdown();
  });

  void it("propagates the association properties through withSpan", () => {
    const parentSpanHandle = Laminar.startSpan({
      name: "parent",
      ...COMMON_ASSOCIATION_PROPERTIES,
    });
    Laminar.withSpan(parentSpanHandle, () => {
      const result = observe({ name: "test" }, () => 3);
      assert.strictEqual(result, 3);
    });
    parentSpanHandle.end();
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const parentSpan = spans.find(span => span.name === "parent");
    const childSpan = spans.find(span => span.name === "test");

    assertAssociationPropertiesPropagated(parentSpan!, childSpan!);
  });

  void it("propagates the association properties through observe decorator", () => {
    const result = observe(
      {
        name: "parentSpan",
        ...COMMON_ASSOCIATION_PROPERTIES,
      },
      () => {
        const childResult = observe({ name: "childSpan" }, () => 3);
        return childResult;
      },
    );
    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const parentSpan = spans.find(span => span.name === "parentSpan");
    const childSpan = spans.find(span => span.name === "childSpan");

    assertAssociationPropertiesPropagated(parentSpan!, childSpan!);
  });

  void it("propagates the association properties through startActiveSpan", () => {
    const parentSpanHandle = Laminar.startActiveSpan({
      name: "parent",
      ...COMMON_ASSOCIATION_PROPERTIES,
    });

    const result = observe({ name: "test" }, () => 3);
    assert.strictEqual(result, 3);
    parentSpanHandle.end();
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const parentSpan = spans.find(span => span.name === "parent");
    const childSpan = spans.find(span => span.name === "test");

    assertAssociationPropertiesPropagated(parentSpan!, childSpan!);
  });
});
