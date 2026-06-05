import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Span } from '@opentelemetry/api';

import { initDebugRuntime, resetDebugRuntime } from '../../src/debug/index';
import {
  cachedPayloadFor,
  markSpanCached,
  replayEnabled,
  spanPathFromSpan,
} from '../../src/debug/replay';
import { SqlQuery } from '../../src/debug/source-trace';

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

// Two-phase SQL double: phase 1 is identified by the metadata SELECT, phase 2
// returns the spine payload rows. Mirrors the Python `_FakeSql`.
class FakeSql implements SqlQuery {
  private metadataRows: Record<string, any>[];
  private payloadRows: Record<string, any>[];

  constructor(metadataRows: Record<string, any>[], payloadRows: Record<string, any>[]) {
    this.metadataRows = metadataRows;
    this.payloadRows = payloadRows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string): Promise<Array<Record<string, any>>> {
    if (sql.includes('span_type, start_time')) {
      const rows = this.metadataRows;
      this.metadataRows = [];
      return rows;
    }
    const rows = this.payloadRows;
    this.payloadRows = [];
    return rows;
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
    process.env.LMNR_DEBUG_CACHE_UNTIL = '1';
    const { runtime } = initDebugRuntime({} as SqlQuery);
    assert.ok(runtime !== null);
    assert.strictEqual(replayEnabled(), true);
  });

  void it('replayEnabled is false for a debug-no-replay runtime', () => {
    // LMNR_DEBUG set but no source trace / cache window: the runtime exists (to
    // stamp rollout.session_id) but replay must stay off so the provider
    // wrappers skip the cache lookup instead of advancing a counter against a
    // cache that will never be built.
    process.env.LMNR_DEBUG = 'true';
    const { runtime } = initDebugRuntime({} as SqlQuery);
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

  void it('cachedPayloadFor uses the runtime and advances the counter', async () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '1';
    const sql = new FakeSql(
      [{ path: 'agent.llm', span_type: 'LLM', start_time: 1.0, end_time: 1.5 }],
      [{ name: 'chat', input: 'a', output: '0', attributes: {} }],
    );
    const { ready } = initDebugRuntime(sql);
    await ready;

    assert.deepStrictEqual(cachedPayloadFor('agent.llm'), {
      name: 'chat',
      input: 'a',
      output: '0',
      attributes: {},
    });
    // Counter advanced -> live now.
    assert.strictEqual(cachedPayloadFor('agent.llm'), undefined);
  });

  void it('cachedPayloadFor returns undefined with no runtime or path', async () => {
    assert.strictEqual(cachedPayloadFor('agent.llm'), undefined);

    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '1';
    const sql = new FakeSql(
      [{ path: 'agent.llm', span_type: 'LLM', start_time: 1.0, end_time: 1.5 }],
      [{ name: 'chat', input: 'a', output: '0', attributes: {} }],
    );
    const { ready } = initDebugRuntime(sql);
    await ready;
    assert.strictEqual(cachedPayloadFor(null), undefined);
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
