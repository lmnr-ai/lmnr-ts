import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildDebugConfig, replayEnabledForConfig } from '../../src/debug/config';

const DEBUG_ENV_KEYS = [
  'LMNR_DEBUG',
  'LMNR_DEBUG_SESSION_ID',
  'LMNR_DEBUG_REPLAY_TRACE_ID',
  'LMNR_DEBUG_CACHE_UNTIL',
  'LMNR_DEBUG_FROM_LAST_RUN',
];

interface ConfigCase {
  name: string;
  env: Record<string, string>;
  expect: {
    session_id: string;
    replay_trace_id: string | null;
    cache_until: number;
    cache_until_span_id?: string | null;
    replay_enabled: boolean;
  } | null;
}

const vectors: ConfigCase[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'debug', 'config_truth_table.json'), 'utf-8'),
).cases;

const clearDebugEnv = () => {
  for (const key of DEBUG_ENV_KEYS) {
    delete process.env[key];
  }
};

void describe('buildDebugConfig (truth table parity)', () => {
  beforeEach(clearDebugEnv);
  afterEach(clearDebugEnv);

  for (const testCase of vectors) {
    void it(testCase.name, () => {
      for (const [key, value] of Object.entries(testCase.env)) {
        process.env[key] = value;
      }

      const config = buildDebugConfig();
      const expect = testCase.expect;

      if (expect === null) {
        assert.strictEqual(config, null);
        return;
      }

      assert.ok(config !== null);
      assert.strictEqual(config.sessionId, expect.session_id);
      assert.strictEqual(config.replayTraceId, expect.replay_trace_id);
      assert.strictEqual(config.cacheUntil, expect.cache_until);
      assert.strictEqual(config.cacheUntilSpanId, expect.cache_until_span_id ?? null);
      assert.strictEqual(replayEnabledForConfig(config), expect.replay_enabled);
    });
  }

  void it('session id defaults to a uuid', () => {
    process.env.LMNR_DEBUG = 'true';
    const config = buildDebugConfig();
    assert.ok(config !== null);
    // A generated uuid4 is 36 chars with 4 hyphens.
    assert.strictEqual(config.sessionId.length, 36);
    assert.strictEqual(config.sessionId.split('-').length - 1, 4);
  });

  void it('disabled when env absent', () => {
    assert.strictEqual(process.env.LMNR_DEBUG, undefined);
    assert.strictEqual(buildDebugConfig(), null);
  });
});

void describe('buildDebugConfig (LMNR_DEBUG_FROM_LAST_RUN)', () => {
  let tmp: string;
  let originalCwd: string;

  const writeLastRun = (payload: Record<string, unknown>) => {
    mkdirSync(join(tmp, '.lmnr'), { recursive: true });
    writeFileSync(join(tmp, '.lmnr', 'last-run.json'), JSON.stringify(payload), 'utf-8');
  };

  beforeEach(() => {
    clearDebugEnv();
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'lmnr-config-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    clearDebugEnv();
  });

  void it('seeds replay from the pointer file', () => {
    writeLastRun({ trace_id: 'trace-abc', session_id: 'session-xyz', cache_until: 5 });
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_FROM_LAST_RUN = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.replayTraceId, 'trace-abc');
    assert.strictEqual(config.sessionId, 'session-xyz');
    assert.strictEqual(config.cacheUntil, 5);
    assert.strictEqual(replayEnabledForConfig(config), true);
  });

  void it('env vars override per-field', () => {
    writeLastRun({ trace_id: 'trace-abc', session_id: 'session-xyz', cache_until: 5 });
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_FROM_LAST_RUN = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-override';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '9';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.replayTraceId, 'trace-override');
    assert.strictEqual(config.sessionId, 'session-xyz');
    assert.strictEqual(config.cacheUntil, 9);
  });

  void it('ignored when flag is falsey', () => {
    writeLastRun({ trace_id: 'trace-abc', session_id: 'session-xyz' });
    process.env.LMNR_DEBUG = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.replayTraceId, null);
    assert.notStrictEqual(config.sessionId, 'session-xyz');
  });

  void it('missing file falls back to env', () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_FROM_LAST_RUN = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.replayTraceId, null);
    assert.strictEqual(config.sessionId.length, 36);
  });
});
