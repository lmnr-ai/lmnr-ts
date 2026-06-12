import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  DEBUG_SESSION_DIR,
  DEBUG_SESSION_FILE,
  type DebugSessionFile,
} from '@lmnr-ai/types';

import {
  readDebugSessionFile,
  writeDebugSessionFile,
} from '../../src/debug/debug-session-file';
import {
  buildDebugSessionFile,
  CONSOLE_PREFIX,
  emitPointer,
} from '../../src/debug/pointer';

// Capture console.log lines and restore cwd after each test.
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

const makeTmpDir = (): string => mkdtempSync(join(tmpdir(), 'lmnr-pointer-'));

void describe('debug session file', () => {
  afterEach(() => {
    process.cwd = originalCwd;
  });

  void it('builds the record with session_id first and all fields', () => {
    const file = buildDebugSessionFile({
      sessionId: 'sess-1',
      traceId: 'trace-1',
      replayTraceId: 'replay-1',
      cacheUntil: '0123456789abcdef',
      debuggerUrl: 'https://www.lmnr.ai',
    });

    assert.deepStrictEqual(Object.keys(file), [
      'session_id',
      'trace_id',
      'replay_trace_id',
      'cache_until',
      'debugger_url',
      'started_at',
    ]);
    assert.strictEqual(file.session_id, 'sess-1');
    assert.strictEqual(file.trace_id, 'trace-1');
    assert.strictEqual(file.replay_trace_id, 'replay-1');
    assert.strictEqual(file.cache_until, '0123456789abcdef');
    assert.strictEqual(file.debugger_url, 'https://www.lmnr.ai');
    assert.ok(typeof file.started_at === 'string' && file.started_at.length > 0);
  });

  void it('keeps trace_id null for a freshly-minted (never-run) session', () => {
    const file = buildDebugSessionFile({
      sessionId: 'sess-1',
      traceId: null,
      replayTraceId: null,
      cacheUntil: null,
      debuggerUrl: null,
    });
    assert.strictEqual(file.trace_id, null);
  });

  void it('emit prints prefixed compact JSON', () => {
    const dir = makeTmpDir();
    process.cwd = () => dir;
    const file = buildDebugSessionFile({
      sessionId: 's',
      traceId: 't',
      replayTraceId: null,
      cacheUntil: null,
      debuggerUrl: null,
    });

    const lines = withCapturedConsole(() => emitPointer(file));
    const out = lines.join('\n').trim();

    assert.ok(out.startsWith(CONSOLE_PREFIX));
    const payload = out.slice(CONSOLE_PREFIX.length);
    // Compact JSON: no spaces after separators.
    assert.ok(!payload.includes(', ') && !payload.includes(': '));
    assert.deepStrictEqual(JSON.parse(payload), file);
  });

  void it('emit always writes the debug-session file (default-on)', () => {
    const dir = makeTmpDir();
    process.cwd = () => dir;
    const file = buildDebugSessionFile({
      sessionId: 's',
      traceId: 't',
      replayTraceId: 'r',
      cacheUntil: 'abcdef',
      debuggerUrl: 'https://www.lmnr.ai',
    });

    withCapturedConsole(() => emitPointer(file));

    const path = join(dir, DEBUG_SESSION_DIR, DEBUG_SESSION_FILE);
    assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf-8')), file);
  });

  void it('emit is best-effort on an unwritable dir', () => {
    // Point cwd at a path under a regular file, so mkdirSync(recursive) raises
    // ENOTDIR; emit must still print and not throw.
    const dir = makeTmpDir();
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    process.cwd = () => filePath;
    const file = buildDebugSessionFile({
      sessionId: 's',
      traceId: 't',
      replayTraceId: null,
      cacheUntil: null,
      debuggerUrl: null,
    });

    const lines = withCapturedConsole(() => emitPointer(file)); // must not throw
    const out = lines.join('\n').trim();
    assert.ok(out.startsWith(CONSOLE_PREFIX));
  });
});

void describe('readDebugSessionFile / writeDebugSessionFile (shared helpers)', () => {
  const sample: DebugSessionFile = {
    session_id: 'sess-rt',
    trace_id: 'trace-rt',
    replay_trace_id: 'replay-rt',
    cache_until: 'abcdef',
    debugger_url: 'https://app.x/project/p/debugger-sessions/sess-rt',
    started_at: '2026-06-11T00:00:00.000Z',
  };

  const writeRaw = (dir: string, contents: string) => {
    mkdirSync(join(dir, DEBUG_SESSION_DIR), { recursive: true });
    writeFileSync(join(dir, DEBUG_SESSION_DIR, DEBUG_SESSION_FILE), contents, 'utf-8');
  };

  void it('round-trips a record through write then read', () => {
    const dir = makeTmpDir();
    const wrote = writeDebugSessionFile(sample, dir);
    assert.strictEqual(wrote, true);
    assert.deepStrictEqual(readDebugSessionFile(dir), sample);
  });

  void it('returns null for a missing file', () => {
    const dir = makeTmpDir();
    assert.strictEqual(readDebugSessionFile(dir), null);
  });

  void it('returns null for a malformed file', () => {
    const dir = makeTmpDir();
    writeRaw(dir, 'not json');
    assert.strictEqual(readDebugSessionFile(dir), null);
  });

  void it('returns null when session_id is missing', () => {
    const dir = makeTmpDir();
    writeRaw(dir, JSON.stringify({ trace_id: 't' }));
    assert.strictEqual(readDebugSessionFile(dir), null);
  });

  void it('coerces non-string fields to null on read', () => {
    const dir = makeTmpDir();
    writeRaw(
      dir,
      JSON.stringify({ session_id: 's', trace_id: 123, started_at: '2026-01-01T00:00:00Z' }),
    );
    const read = readDebugSessionFile(dir);
    assert.ok(read !== null);
    assert.strictEqual(read.session_id, 's');
    assert.strictEqual(read.trace_id, null);
    assert.strictEqual(read.replay_trace_id, null);
    assert.strictEqual(read.cache_until, null);
    assert.strictEqual(read.debugger_url, null);
  });
});
