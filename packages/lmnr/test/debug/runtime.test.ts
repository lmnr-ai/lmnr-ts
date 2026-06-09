import * as assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import type { CacheOutcome, RolloutSessionsResource } from '@lmnr-ai/client';

import { DebugConfig } from '../../src/debug/config';
import {
  DebugRuntime,
  getRuntime,
  initDebugRuntime,
  resetDebugRuntime,
} from '../../src/debug/index';

// Minimal stand-in for the client resource the runtime routes cache lookups
// through. Records the args it was called with and returns a fixed outcome.
class FakeRolloutSessions {
  public calls: Record<string, unknown>[] = [];
  constructor(private outcome: CacheOutcome = { kind: 'live' }) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async cache(args: Record<string, unknown>): Promise<CacheOutcome> {
    this.calls.push(args);
    return this.outcome;
  }
}

const asResource = (f: FakeRolloutSessions): RolloutSessionsResource =>
  f as unknown as RolloutSessionsResource;

const config = (overrides: Partial<DebugConfig> = {}): DebugConfig => ({
  sessionId: 's',
  replayTraceId: 'r',
  cacheUntilSpanId: 'abc',
  localOrigin: true,
  sessionMinted: true,
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
  // Some emitPointer tests don't override process.cwd, so they best-effort write
  // `.lmnr/last-run.json` into the real cwd. Only remove the dir afterwards if
  // this run is what created it — never clobber a pre-existing one.
  const pointerDir = join(originalCwd(), '.lmnr');
  let pointerDirPreexisted = false;
  before(() => {
    pointerDirPreexisted = existsSync(pointerDir);
  });
  after(() => {
    if (!pointerDirPreexisted && existsSync(pointerDir)) {
      rmSync(pointerDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
  });
  afterEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
    process.cwd = originalCwd;
  });

  void it('lookupCache forwards the session/replay/span-id and returns the outcome', async () => {
    const fake = new FakeRolloutSessions({
      kind: 'hit',
      cached: { name: '', input: '', output: '"hi"', attributes: {} },
    });
    const runtime = new DebugRuntime(
      config({ sessionId: 'sess', replayTraceId: 'trace', cacheUntilSpanId: 'span' }),
      asResource(fake),
      null,
    );

    const outcome = await runtime.lookupCache('deadbeef');
    assert.deepStrictEqual(fake.calls, [
      {
        sessionId: 'sess',
        replayTraceId: 'trace',
        cacheUntil: 'span',
        inputHash: 'deadbeef',
      },
    ]);
    assert.strictEqual(outcome.kind, 'hit');
  });

  void it('lookupCache degrades to live when replay is not configured', async () => {
    const fake = new FakeRolloutSessions({ kind: 'miss' });
    const runtime = new DebugRuntime(
      config({ cacheUntilSpanId: null }),
      asResource(fake),
      null,
    );

    const outcome = await runtime.lookupCache('deadbeef');
    assert.strictEqual(outcome.kind, 'live');
    // No request is made when the window is unconfigured.
    assert.strictEqual(fake.calls.length, 0);
  });

  void it('rebindRolloutSessions swaps the handle used by lookupCache', async () => {
    // A from-context runtime armed BEFORE initialize() builds its cache client
    // from unset connection args. Once initialize() supplies the real
    // baseUrl/port/api-key it rebinds the handle, so later lookupCache calls must
    // route through the NEW resource (the stale one never receives them).
    const stale = new FakeRolloutSessions({ kind: 'live' });
    const fresh = new FakeRolloutSessions({
      kind: 'hit',
      cached: { name: '', input: '', output: '"hi"', attributes: {} },
    });
    const runtime = new DebugRuntime(
      config({ sessionId: 'sess', replayTraceId: 'trace', cacheUntilSpanId: 'span' }),
      asResource(stale),
      null,
    );

    runtime.rebindRolloutSessions(asResource(fresh));
    const outcome = await runtime.lookupCache('deadbeef');

    assert.strictEqual(outcome.kind, 'hit');
    assert.strictEqual(stale.calls.length, 0);
    assert.deepStrictEqual(fresh.calls, [
      {
        sessionId: 'sess',
        replayTraceId: 'trace',
        cacheUntil: 'span',
        inputHash: 'deadbeef',
      },
    ]);
  });

  void it('replayConfigured reflects both ids being present', () => {
    const fake = asResource(new FakeRolloutSessions());
    assert.strictEqual(new DebugRuntime(config(), fake, null).replayConfigured, true);
    assert.strictEqual(
      new DebugRuntime(config({ replayTraceId: null }), fake, null).replayConfigured,
      false,
    );
    assert.strictEqual(
      new DebugRuntime(config({ cacheUntilSpanId: null }), fake, null).replayConfigured,
      false,
    );
  });

  void it('recordTraceId keeps the first trace id', () => {
    const runtime = new DebugRuntime(config(), asResource(new FakeRolloutSessions()), null);
    runtime.recordTraceId('trace-a');
    runtime.recordTraceId('trace-b');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = lines[0].slice('LMNR_DEBUG_RUN '.length);
    assert.strictEqual(JSON.parse(payload).trace_id, 'trace-a');
  });

  void it('recordProjectId keeps the first project id', () => {
    const runtime = new DebugRuntime(
      config(),
      asResource(new FakeRolloutSessions()),
      'https://x',
    );
    runtime.recordProjectId('proj-a');
    runtime.recordProjectId('proj-b');
    assert.strictEqual(runtime.debuggerSessionUrl(),
      'https://x/project/proj-a/debugger-sessions/s');
  });

  void it('debuggerSessionUrl falls back to the base before a project id', () => {
    const runtime = new DebugRuntime(
      config(),
      asResource(new FakeRolloutSessions()),
      'https://app.x',
    );
    assert.strictEqual(runtime.debuggerSessionUrl(), 'https://app.x');
  });

  void it('debuggerSessionUrl is null without a base url', () => {
    const runtime = new DebugRuntime(config(), asResource(new FakeRolloutSessions()), null);
    assert.strictEqual(runtime.debuggerSessionUrl(), null);
  });

  void it('debuggerSessionUrl is the full per-session url once known', () => {
    const runtime = new DebugRuntime(
      config({ sessionId: 'sess-1' }),
      asResource(new FakeRolloutSessions()),
      'https://app.x',
    );
    runtime.recordProjectId('proj-1');
    assert.strictEqual(runtime.debuggerSessionUrl(),
      'https://app.x/project/proj-1/debugger-sessions/sess-1');
  });

  void it('emitPointer carries the full debugger url', () => {
    // The pointer's debugger_url must carry the SAME full per-session URL the
    // console prints, built via the shared debuggerSessionUrl code path.
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(
      config({ sessionId: 'sess-1' }),
      asResource(new FakeRolloutSessions()),
      'https://app.x',
    );
    runtime.recordProjectId('proj-1');
    runtime.recordTraceId('trace-a');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = JSON.parse(lines[0].slice('LMNR_DEBUG_RUN '.length));
    assert.strictEqual(payload.debugger_url,
      'https://app.x/project/proj-1/debugger-sessions/sess-1');
  });

  void it('emitPointer carries the cache-until span id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(
      config({ cacheUntilSpanId: '0123456789abcdef' }),
      asResource(new FakeRolloutSessions()),
      null,
    );
    runtime.recordTraceId('trace-a');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = JSON.parse(lines[0].slice('LMNR_DEBUG_RUN '.length));
    assert.strictEqual(payload.cache_until, '0123456789abcdef');
  });

  void it('emitPointer uses the construction-time started_at', async () => {
    // started_at must reflect when the run began (runtime construction at SDK
    // init), not when the pointer is emitted (shutdown). Wait between the two so
    // an emit-time timestamp would land strictly after the construction window.
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(config(), asResource(new FakeRolloutSessions()), null);
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
    const runtime = new DebugRuntime(config(), asResource(new FakeRolloutSessions()), null);
    runtime.recordTraceId('trace-a');
    const lines = withCapturedConsole(() => {
      runtime.emitPointer();
      runtime.emitPointer();
    });
    const pointerLines = lines.filter((l) => l.startsWith('LMNR_DEBUG_RUN '));
    assert.strictEqual(pointerLines.length, 1);
  });

  void it('emitPointer is a no-op for a downstream (inherited) run', () => {
    // A runtime armed from a propagated DebugContext (localOrigin=false) joins
    // the upstream replay session and must NOT write a run pointer — the origin
    // owns it. Gated inside emitPointer so shutdown()/exit-hook stay safe.
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-runtime-'));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(
      config({ localOrigin: false }),
      asResource(new FakeRolloutSessions()),
      null,
    );
    runtime.recordTraceId('trace-downstream');
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const pointerLines = lines.filter((l) => l.startsWith('LMNR_DEBUG_RUN '));
    assert.strictEqual(pointerLines.length, 0);
    assert.strictEqual(existsSync(join(dir, '.lmnr', 'last-run.json')), false);
  });

  void it('init returns null when disabled', () => {
    const { runtime } = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.strictEqual(runtime, null);
    assert.strictEqual(getRuntime(), null);
  });

  void it('init off does not latch the one-shot flag', () => {
    // When debug is off, init must NOT spend the one-shot flag: a later init
    // after the env flips LMNR_DEBUG on must still build a runtime without an
    // intervening resetDebugRuntime().
    const off = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.strictEqual(off.runtime, null);

    process.env.LMNR_DEBUG = 'true';
    const on = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.ok(on.runtime !== null);
    assert.strictEqual(getRuntime(), on.runtime);
  });

  void it('init is idempotent', () => {
    process.env.LMNR_DEBUG = 'true';
    const first = initDebugRuntime(asResource(new FakeRolloutSessions()));
    const second = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.strictEqual(first.runtime, second.runtime);
    assert.strictEqual(first.runtime, getRuntime());
  });

  void it('reset allows reinit to re-read env', () => {
    // A shutdown/initialize cycle must re-read LMNR_DEBUG*: reset clears the
    // one-shot flag so a previously-off run can turn debug on (and vice versa).
    const off = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.strictEqual(off.runtime, null);

    resetDebugRuntime();
    process.env.LMNR_DEBUG = 'true';
    const on = initDebugRuntime(asResource(new FakeRolloutSessions()));
    assert.ok(on.runtime !== null);
    assert.strictEqual(getRuntime(), on.runtime);
  });
});
