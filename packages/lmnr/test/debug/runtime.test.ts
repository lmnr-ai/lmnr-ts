import * as assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CachedSpan } from '@lmnr-ai/types';

import { DebugConfig } from '../../src/debug/config';
import {
  DebugRuntime,
  getRuntime,
  initDebugRuntime,
  resetDebugRuntime,
} from '../../src/debug/index';
import { ReplayCache } from '../../src/debug/replay-cache';
import { SqlQuery } from '../../src/debug/source-trace';

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

class BoomSql implements SqlQuery {
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(): Promise<Array<Record<string, any>>> {
    throw new Error('network down');
  }
}

const config = (overrides: Partial<DebugConfig> = {}): DebugConfig => ({
  sessionId: 's',
  replayTraceId: 'r',
  cacheUntil: 2,
  ...overrides,
});

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

const originalLog = console.log.bind(console);
const originalCwd = process.cwd.bind(process);

const withCapturedConsole = (fn: () => void): string[] => {
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    fn();
  } finally {

    console.log = originalLog;
  }
  return lines;
};

void describe('DebugRuntime', () => {
  beforeEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
  });
  afterEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
    process.cwd = originalCwd;
  });

  void it('getCached advances the occurrence counter', () => {
    const cache = new ReplayCache('loop.llm', 2, [
      { output: '0' } as unknown as CachedSpan,
      { output: '1' } as unknown as CachedSpan,
    ]);
    const runtime = new DebugRuntime(config(), cache, null);

    assert.deepStrictEqual(runtime.getCached('loop.llm'), { output: '0' });
    assert.deepStrictEqual(runtime.getCached('loop.llm'), { output: '1' });
    // Past the window -> live.
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);
    // Non-spine path -> live, even on the first occurrence.
    assert.strictEqual(runtime.getCached('other'), undefined);
  });

  void it('getCached returns undefined with no cache', () => {
    const runtime = new DebugRuntime(config(), null, null);
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);
  });

  void it('getCached advances the counter while the cache is loading', () => {
    // Simulates the async-fill window: calls happen before setCache. The
    // counter must advance so post-setCache calls resume at the right slot.
    const runtime = new DebugRuntime(config(), null, null);
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);

    runtime.setCache(
      new ReplayCache('loop.llm', 2, [
        { output: '0' } as unknown as CachedSpan,
        { output: '1' } as unknown as CachedSpan,
      ]),
    );

    // First live call consumed occurrence 0; the cache resumes at 1.
    assert.deepStrictEqual(runtime.getCached('loop.llm'), { output: '1' });
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);
  });

  void it('recordTraceId keeps the first trace id', () => {
    const runtime = new DebugRuntime(config(), null, null);
    runtime.recordTraceId('trace-a');
    runtime.recordTraceId('trace-b');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = lines[0].slice('LMNR_DEBUG_RUN '.length);
    assert.strictEqual(JSON.parse(payload).trace_id, 'trace-a');
  });

  void it('emitPointer uses the construction-time started_at', async () => {
    // started_at must reflect when the run began (runtime construction at SDK
    // init), not when the pointer is emitted (shutdown). Wait between the two so
    // an emit-time timestamp would land strictly after the construction window.
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(config(), null, null);
    const afterConstruct = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.recordTraceId('trace-a');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = JSON.parse(lines[0].slice('LMNR_DEBUG_RUN '.length));
    // Captured at/before construction, so it cannot be later than the timestamp
    // taken right after the constructor — an emit-time value would exceed it.
    assert.ok(payload.started_at <= afterConstruct);
  });

  void it('emitPointer only emits once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(config(), null, null);
    runtime.recordTraceId('trace-a');
    const lines = withCapturedConsole(() => {
      runtime.emitPointer();
      runtime.emitPointer();
    });
    const pointerLines = lines.filter((l) => l.startsWith('LMNR_DEBUG_RUN '));
    assert.strictEqual(pointerLines.length, 1);
  });

  void it('init returns null when disabled', () => {
    const { runtime } = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(runtime, null);
    assert.strictEqual(getRuntime(), null);
  });

  void it('init is idempotent', () => {
    process.env.LMNR_DEBUG = 'true';
    const first = initDebugRuntime({} as SqlQuery);
    const second = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(first.runtime, second.runtime);
    assert.strictEqual(first.runtime, getRuntime());
  });

  void it('reset allows reinit to re-read env', () => {
    // A shutdown/initialize cycle must re-read LMNR_DEBUG*: reset clears the
    // one-shot flag so a previously-off run can turn debug on (and vice versa).
    const off = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(off.runtime, null);

    resetDebugRuntime();
    process.env.LMNR_DEBUG = 'true';
    const on = initDebugRuntime({} as SqlQuery);
    assert.ok(on.runtime !== null);
    assert.strictEqual(getRuntime(), on.runtime);
  });

  void it('init builds the cache for a looping spine', async () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '2';

    const metadata = [
      { path: 'agent.loop.llm', span_type: 'LLM', start_time: 1.0, end_time: 1.5 },
      { path: 'agent.loop.llm', span_type: 'LLM', start_time: 2.0, end_time: 2.5 },
    ];
    const payloads = [
      { name: 'chat', input: 'a', output: '0', attributes: {} },
      { name: 'chat', input: 'b', output: '1', attributes: {} },
    ];
    const sql = new FakeSql(metadata, payloads);

    const { runtime, ready } = initDebugRuntime(sql, 'https://www.lmnr.ai');
    await ready;
    assert.ok(runtime !== null);
    assert.deepStrictEqual(runtime.getCached('agent.loop.llm'), {
      name: 'chat',
      input: 'a',
      output: '0',
      attributes: {},
    });
  });

  void it('init degrades to live on overlap', async () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '2';

    const metadata = [
      { path: 'loop.llm', span_type: 'LLM', start_time: 0.0, end_time: 1.5 },
      { path: 'loop.llm', span_type: 'LLM', start_time: 1.0, end_time: 2.0 },
    ];
    const sql = new FakeSql(metadata, []);

    const { runtime, ready } = initDebugRuntime(sql);
    await ready;
    assert.ok(runtime !== null);
    // Overlap guard -> no cache -> every call runs live.
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);
  });

  void it('init degrades to live on fetch failure', async () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '2';

    const { runtime, ready } = initDebugRuntime(new BoomSql());
    await ready;
    assert.ok(runtime !== null); // never crashes
    assert.strictEqual(runtime.getCached('loop.llm'), undefined);
  });
});
