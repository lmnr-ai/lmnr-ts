import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildDebugConfig,
  buildDebugConfigFromContext,
  replayEnabledForConfig,
  resolveDebugRunNote,
} from '../../src/debug/config';
import { deserializeLaminarSpanContext } from '../../src/utils';

const SESSION = '00000000-0000-0000-0000-0000000000aa';
const REPLAY = '00000000-0000-0000-0000-0000000000bb';

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

// Truth-table + minted cases read `.lmnr/debug-session.json` from cwd. Pin cwd
// to an empty temp dir so a stray file in the package dir can't leak in.
const originalCwd = process.cwd();

void describe('buildDebugConfig (truth table parity)', () => {
  let tmp: string;
  beforeEach(() => {
    clearDebugEnv();
    tmp = mkdtempSync(join(tmpdir(), 'lmnr-config-tt-'));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    clearDebugEnv();
  });

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

void describe('buildDebugConfig (.lmnr/debug-session.json continuation)', () => {
  let tmp: string;

  const writeSessionFile = (payload: Record<string, unknown>) => {
    mkdirSync(join(tmp, '.lmnr'), { recursive: true });
    writeFileSync(
      join(tmp, '.lmnr', 'debug-session.json'),
      JSON.stringify(payload),
      'utf-8',
    );
  };

  beforeEach(() => {
    clearDebugEnv();
    tmp = mkdtempSync(join(tmpdir(), 'lmnr-config-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    clearDebugEnv();
  });

  void it('rejoins the file session silently (continuation, not minted)', () => {
    writeSessionFile({
      session_id: 'session-xyz',
      trace_id: 'trace-abc',
      replay_trace_id: null,
      cache_until: '0123-456789abcdef',
      debugger_url: null,
      started_at: '2026-01-01T00:00:00.000Z',
    });
    process.env.LMNR_DEBUG = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    // The session id comes from the file; the browser must NOT reopen.
    assert.strictEqual(config.sessionId, 'session-xyz');
    assert.strictEqual(config.sessionMinted, false);
    assert.strictEqual(config.localOrigin, true);
    // Continuation is NOT replay: the prior run's trace_id is NOT promoted into
    // replayTraceId. Only an explicit replay_trace_id (file or env) arms replay.
    assert.strictEqual(config.replayTraceId, null);
    // cache_until is read from the file when the env var is unset.
    assert.strictEqual(config.cacheUntilSpanId, '0123456789abcdef');
  });

  void it('reads replay_trace_id and cache_until from the file when env is unset', () => {
    writeSessionFile({
      session_id: 'session-xyz',
      trace_id: 'trace-abc',
      replay_trace_id: 'replay-from-file',
      cache_until: 'abcdef',
      debugger_url: null,
      started_at: '2026-01-01T00:00:00.000Z',
    });
    process.env.LMNR_DEBUG = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.replayTraceId, 'replay-from-file');
    assert.strictEqual(config.cacheUntilSpanId, 'abcdef');
    assert.strictEqual(replayEnabledForConfig(config), true);
  });

  void it('env overrides the file per-field', () => {
    writeSessionFile({
      session_id: 'session-xyz',
      trace_id: 'trace-abc',
      replay_trace_id: 'replay-from-file',
      cache_until: '0123-456789abcdef',
      debugger_url: null,
      started_at: '2026-01-01T00:00:00.000Z',
    });
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_SESSION_ID = 'env-session';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'env-replay';
    process.env.LMNR_DEBUG_CACHE_UNTIL = 'cafe';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    // Explicit env session id wins over the file and is still a continuation.
    assert.strictEqual(config.sessionId, 'env-session');
    assert.strictEqual(config.sessionMinted, false);
    assert.strictEqual(config.replayTraceId, 'env-replay');
    assert.strictEqual(config.cacheUntilSpanId, 'cafe');
  });

  void it('mints a fresh session when no file and no env id (browser opens)', () => {
    process.env.LMNR_DEBUG = 'true';

    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.sessionId.length, 36);
    assert.strictEqual(config.sessionMinted, true);
    assert.strictEqual(config.localOrigin, true);
    assert.strictEqual(config.replayTraceId, null);
  });
});

void describe('local origin / session minted', () => {
  let tmp: string;
  beforeEach(() => {
    clearDebugEnv();
    tmp = mkdtempSync(join(tmpdir(), 'lmnr-config-mint-'));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    clearDebugEnv();
  });

  void it('a fresh env run is local origin and minted', () => {
    process.env.LMNR_DEBUG = 'true';
    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.localOrigin, true);
    assert.strictEqual(config.sessionMinted, true);
  });

  void it('a provided session id is not minted', () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_SESSION_ID = 'sess-123';
    const config = buildDebugConfig();
    assert.ok(config !== null);
    assert.strictEqual(config.sessionMinted, false);
  });
});

void describe('buildDebugConfigFromContext (inherited path)', () => {
  void it('builds a downstream config from an armed block', () => {
    const config = buildDebugConfigFromContext({
      enabled: true,
      sessionId: SESSION,
      replayTraceId: REPLAY,
      cacheUntil: '0123-456789abcdef',
    });
    assert.ok(config !== null);
    assert.strictEqual(config.sessionId, SESSION);
    assert.strictEqual(config.replayTraceId, REPLAY);
    assert.strictEqual(config.cacheUntilSpanId, '0123456789abcdef');
    assert.strictEqual(config.localOrigin, false);
    assert.strictEqual(config.sessionMinted, false);
    assert.strictEqual(replayEnabledForConfig(config), true);
  });

  void it('returns null when not enabled', () => {
    assert.strictEqual(
      buildDebugConfigFromContext({ enabled: false, sessionId: SESSION }),
      null,
    );
  });

  void it('returns null when no session id', () => {
    assert.strictEqual(buildDebugConfigFromContext({ enabled: true }), null);
  });

  void it('returns null when block absent', () => {
    assert.strictEqual(buildDebugConfigFromContext(undefined), null);
  });
});

void describe('LaminarSpanContext debug block parsing', () => {
  void it('parses a nested camelCase debug block', () => {
    const ctx = deserializeLaminarSpanContext({
      traceId: SESSION,
      spanId: REPLAY,
      debug: {
        enabled: true,
        sessionId: SESSION,
        replayTraceId: REPLAY,
        cacheUntil: '0123-456789abcdef',
      },
    });
    assert.ok(ctx.debug !== undefined);
    assert.strictEqual(ctx.debug.enabled, true);
    assert.strictEqual(ctx.debug.sessionId, SESSION);
    assert.strictEqual(ctx.debug.replayTraceId, REPLAY);
    assert.strictEqual(ctx.debug.cacheUntil, '0123-456789abcdef');
  });

  void it('parses a nested snake_case debug block', () => {
    const ctx = deserializeLaminarSpanContext({
      trace_id: SESSION,
      span_id: REPLAY,
      debug: {
        enabled: true,
        session_id: SESSION,
        replay_trace_id: REPLAY,
        cache_until: 'abcdef',
      },
    });
    assert.ok(ctx.debug !== undefined);
    assert.strictEqual(ctx.debug.sessionId, SESSION);
    assert.strictEqual(ctx.debug.replayTraceId, REPLAY);
    assert.strictEqual(ctx.debug.cacheUntil, 'abcdef');
  });

  void it('keeps non-UUID ids verbatim', () => {
    // LMNR_DEBUG_SESSION_ID may be an arbitrary string; the origin registers
    // and propagates that exact value, so the consumer must round-trip it
    // unchanged or the downstream treats the block as session-less and never
    // joins the run.
    const ctx = deserializeLaminarSpanContext({
      traceId: SESSION,
      spanId: REPLAY,
      debug: { enabled: true, sessionId: 'my-session', replayTraceId: 'my-replay' },
    });
    assert.ok(ctx.debug !== undefined);
    assert.strictEqual(ctx.debug.sessionId, 'my-session');
    assert.strictEqual(ctx.debug.replayTraceId, 'my-replay');
  });

  void it('drops empty-string ids to undefined', () => {
    const ctx = deserializeLaminarSpanContext({
      traceId: SESSION,
      spanId: REPLAY,
      debug: { enabled: true, sessionId: '', replayTraceId: '' },
    });
    assert.ok(ctx.debug !== undefined);
    assert.strictEqual(ctx.debug.sessionId, undefined);
    assert.strictEqual(ctx.debug.replayTraceId, undefined);
  });

  void it('debug is undefined when no block present', () => {
    const ctx = deserializeLaminarSpanContext({ traceId: SESSION, spanId: REPLAY });
    assert.strictEqual(ctx.debug, undefined);
  });

  void it('a non-boolean enabled never arms the block', () => {
    // The producer always emits a real boolean. A truthy non-true value (e.g.
    // the JSON string "false", or 1) is a malformed/forged block and must parse
    // to enabled:false, never arming a downstream runtime.
    for (const enabled of ['false', 'true', 1, {}] as unknown[]) {
      const ctx = deserializeLaminarSpanContext({
        traceId: SESSION,
        spanId: REPLAY,
        debug: { enabled, sessionId: SESSION },
      });
      assert.ok(ctx.debug !== undefined);
      assert.strictEqual(ctx.debug.enabled, false);
    }
  });
});

void describe('resolveDebugRunNote', () => {
  const NOTE_ENV_KEYS = ['LMNR_DEBUG', 'LMNR_DEBUG_RUN_NOTES', 'LMNR_DEBUG_RUN_NOTES_FILE'];
  const clearNoteEnv = () => {
    for (const key of NOTE_ENV_KEYS) {
      delete process.env[key];
    }
  };

  let tmp: string;
  beforeEach(() => {
    clearNoteEnv();
    tmp = mkdtempSync(join(tmpdir(), 'lmnr-note-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    clearNoteEnv();
  });

  void it('returns null when debug is off, even with note vars set', () => {
    process.env.LMNR_DEBUG_RUN_NOTES = 'inline note';
    assert.strictEqual(resolveDebugRunNote(), null);
  });

  void it('reads inline LMNR_DEBUG_RUN_NOTES when debug is on', () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_RUN_NOTES = '## inline\nbody';
    assert.strictEqual(resolveDebugRunNote(), '## inline\nbody');
  });

  void it('LMNR_DEBUG_RUN_NOTES_FILE wins over inline', () => {
    const file = join(tmp, 'note.md');
    writeFileSync(file, '## from file\nbody');
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_RUN_NOTES = 'inline note';
    process.env.LMNR_DEBUG_RUN_NOTES_FILE = file;
    assert.strictEqual(resolveDebugRunNote(), '## from file\nbody');
  });

  void it('returns null (no inline fallback) when the file is unreadable', () => {
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_RUN_NOTES = 'inline note';
    process.env.LMNR_DEBUG_RUN_NOTES_FILE = join(tmp, 'missing.md');
    assert.strictEqual(resolveDebugRunNote(), null);
  });

  void it('returns null when no note var is set', () => {
    process.env.LMNR_DEBUG = 'true';
    assert.strictEqual(resolveDebugRunNote(), null);
  });
});
