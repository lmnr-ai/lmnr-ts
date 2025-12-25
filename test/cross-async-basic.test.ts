import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { type Span } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { getTracer, observe } from '../src';
import { Laminar } from '../src/laminar';
import { _resetConfiguration, initializeTracing } from '../src/opentelemetry-lib/configuration';
import { getParentSpanId } from '../src/opentelemetry-lib/tracing/compat';

void describe('Cross-Async Span Management - Basic Tests', () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it('start span in one async context and end it in another async context', async () => {
    // Simulate a complex workflow with multiple async operations

    let spanA: Span | undefined;
    let spanB: Span | undefined;

    const fnA = async () => {
      spanA = Laminar.startActiveSpan({ name: 'fnA' });
      await new Promise(resolve => setTimeout(resolve, 100));

      // span B should be a in a different trace because span A is ended in fnB
      spanB = Laminar.startActiveSpan({ name: 'fnB' });
      await new Promise(resolve => setTimeout(resolve, 10));
      spanB.end();
    };

    const fnB = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      spanA?.end();
    };

    await Promise.all([fnA(), fnB()]);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const spanAResult = spans.find(span => span.name === 'fnA');
    const spanBResult = spans.find(span => span.name === 'fnB');

    assert.notStrictEqual(spanAResult!.spanContext().traceId, spanBResult!.spanContext().traceId);
  });

  void it('start span in one async context and end it in another async context reverse',
    async () => {
      // Simulate a complex workflow with multiple async operations

      let spanA: Span | undefined;
      let spanB: Span | undefined;

      const fnA = async () => {
        spanA = Laminar.startActiveSpan({ name: 'fnA' });
        await new Promise(resolve => setTimeout(resolve, 100));

        // span B should be a in a different trace because span A is ended in fnB
        spanB = Laminar.startActiveSpan({ name: 'fnB' });
        await new Promise(resolve => setTimeout(resolve, 10));
        spanB.end();
      };

      const fnB = async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        spanA?.end();
      };

      await Promise.all([fnB(), fnA()]);

      const spans = exporter.getFinishedSpans();
      const spanAResult = spans.find(span => span.name === 'fnA');
      const spanBResult = spans.find(span => span.name === 'fnB');

      assert.notStrictEqual(spanAResult!.spanContext().traceId, spanBResult!.spanContext().traceId);
    });
});

void describe('Cross-Async Span Management - Promises inherit context', () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it('correctly propagates the context to the promise', async () => {
    // Sleep for a little bit to ensure the parent span is ended
    const sleepFor = 10;

    const nextMicrotask = () => new Promise(resolve => setTimeout(resolve, sleepFor));
    let deferredChildSpan: Promise<void> | undefined;

    await observe({ name: 'parent' }, () => {
      // Create a promise that will create a child span LATER
      deferredChildSpan = nextMicrotask().then(() => {
        const childSpan = getTracer().startSpan('child');
        childSpan.end();
      });
    });
    // outer span is ended by this time

    // Wait for the deferred child span creation
    await deferredChildSpan;

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const parentSpan = spans.find(span => span.name === 'parent');
    const childSpan = spans.find(span => span.name === 'child');

    assert.strictEqual(parentSpan!.spanContext().traceId, childSpan!.spanContext().traceId);
    assert.strictEqual(getParentSpanId(childSpan!), parentSpan!.spanContext().spanId);
  });
});
