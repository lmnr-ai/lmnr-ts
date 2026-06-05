import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { RolloutSessionsResource } from '@lmnr-ai/client';
import { Span } from '@opentelemetry/api';

import { initDebugRuntime, resetDebugRuntime } from '../../src/debug/index';
import { markSpanCached, replayEnabled, spanPathFromSpan } from '../../src/debug/replay';

// The replay helpers never touch the resource; a bare cast is enough.
const fakeResource = {} as unknown as RolloutSessionsResource;

// Minimal recording-span double that exposes the attributes bag + setAttributes.
class FakeSpan {
  attributes: Record<string, unknown>;
  marked: Record<string, unknown> = {};
  private _recording: boolean;

  constructor(attributes: Record<string, unknown>, recording = true) {
    this.attributes = attributes;
    this._recording = recording;
  }

  isRecording(): boolean {
    return this._recording;
  }

  setAttributes(attrs: Record<string, unknown>): void {
    Object.assign(this.marked, attrs);
  }
}

const DEBUG_ENV_KEYS = [
  'LMNR_DEBUG',
  'LMNR_DEBUG_SESSION_ID',
  'LMNR_DEBUG_REPLAY_TRACE_ID',
  'LMNR_DEBUG_CACHE_UNTIL',
];

const clearDebugEnv = () => {
  for (const key of DEBUG_ENV_KEYS) {
    delete process.env[key];
  }
};

void describe('debug replay helpers', () => {
  beforeEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
  });
  afterEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
  });

  void it('replayEnabled is true only when replay is configured', () => {
    assert.strictEqual(replayEnabled(), false);
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '0123456789abcdef';
    const { runtime } = initDebugRuntime(fakeResource);
    assert.ok(runtime !== null);
    assert.strictEqual(replayEnabled(), true);
  });

  void it('replayEnabled is false for a debug-no-replay runtime', () => {
    // LMNR_DEBUG set but no replay trace / cache-until span id: the runtime
    // exists (to stamp rollout.session_id) but replay must stay off so the
    // provider wrappers skip the per-call cache lookup entirely.
    process.env.LMNR_DEBUG = 'true';
    const { runtime } = initDebugRuntime(fakeResource);
    assert.ok(runtime !== null);
    assert.strictEqual(replayEnabled(), false);
  });

  void it('spanPathFromSpan joins with a dot', () => {
    const span = new FakeSpan({ 'lmnr.span.path': ['agent', 'loop', 'llm'] });
    assert.strictEqual(spanPathFromSpan(span as unknown as Span), 'agent.loop.llm');
  });

  void it('spanPathFromSpan handles missing input', () => {
    assert.strictEqual(spanPathFromSpan(null), null);
    assert.strictEqual(spanPathFromSpan(new FakeSpan({}) as unknown as Span), null);
  });

  void it('markSpanCached sets the boundary attributes', () => {
    const span = new FakeSpan({});
    markSpanCached(span as unknown as Span);
    assert.deepStrictEqual(span.marked, {
      'lmnr.span.type': 'CACHED',
      'lmnr.span.original_type': 'LLM',
    });
  });

  void it('markSpanCached is a no-op when not recording', () => {
    const span = new FakeSpan({}, false);
    markSpanCached(span as unknown as Span);
    assert.deepStrictEqual(span.marked, {});
  });

  void it('markSpanCached handles null', () => {
    markSpanCached(null); // must not throw
  });
});
