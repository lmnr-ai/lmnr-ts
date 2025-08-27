import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { Laminar } from '../src/laminar';
import { _resetConfiguration } from '../src/opentelemetry-lib/configuration';
import { Span } from '@opentelemetry/api';

void describe('Cross-Async Span Management - Basic Tests', () => {
  void beforeEach(() => {
    _resetConfiguration();
    Laminar.initialize({
      projectApiKey: 'test-key',
      disableBatch: true,
    });
  });

  void afterEach(async () => {
    await Laminar.flush();
  });

  void it('start span in one async context and end it in another async context should not affect other spans in original context', async () => {
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

    assert.notStrictEqual(spanA?.spanContext().traceId, spanB?.spanContext().traceId);
  });
});


