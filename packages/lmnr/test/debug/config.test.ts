import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildDebugConfig, replayEnabledForConfig } from '../../src/debug/config';

const DEBUG_ENV_KEYS = [
  'LMNR_DEBUG',
  'LMNR_DEBUG_SESSION_ID',
  'LMNR_DEBUG_REPLAY_TRACE_ID',
  'LMNR_DEBUG_CACHE_UNTIL',
];

interface ConfigCase {
  name: string;
  env: Record<string, string>;
  expect: {
    session_id: string;
    replay_trace_id: string | null;
    cache_until: number;
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
