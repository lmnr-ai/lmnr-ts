import * as assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildPointer,
  CONSOLE_PREFIX,
  emitPointer,
  POINTER_DIR,
  POINTER_FILE,
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

void describe('debug pointer', () => {
  afterEach(() => {
    process.cwd = originalCwd;
    delete process.env.LMNR_DEBUG_WRITE_LAST_RUN_TO_FILE;
  });

  void it('build pointer key order and values', () => {
    const pointer = buildPointer({
      traceId: 'trace-1',
      sessionId: 'sess-1',
      replayTraceId: 'replay-1',
      cacheUntil: 3,
      debuggerUrl: 'https://www.lmnr.ai',
    });

    // Key order is part of the cross-language parity contract.
    assert.deepStrictEqual(Object.keys(pointer), [
      'trace_id',
      'session_id',
      'replay_trace_id',
      'cache_until',
      'debugger_url',
      'started_at',
    ]);
    assert.strictEqual(pointer.trace_id, 'trace-1');
    assert.strictEqual(pointer.session_id, 'sess-1');
    assert.strictEqual(pointer.replay_trace_id, 'replay-1');
    assert.strictEqual(pointer.cache_until, 3);
    assert.strictEqual(pointer.debugger_url, 'https://www.lmnr.ai');
    assert.ok(typeof pointer.started_at === 'string' && pointer.started_at.length > 0);
  });

  void it('emit pointer prints prefixed compact JSON', () => {
    const dir = makeTmpDir();
    process.cwd = () => dir;
    const pointer = buildPointer({
      traceId: 't',
      sessionId: 's',
      replayTraceId: null,
      cacheUntil: 0,
      debuggerUrl: null,
    });

    const lines = withCapturedConsole(() => emitPointer(pointer));
    const out = lines.join('\n').trim();

    assert.ok(out.startsWith(CONSOLE_PREFIX));
    const payload = out.slice(CONSOLE_PREFIX.length);
    // Compact JSON: no spaces after separators.
    assert.ok(!payload.includes(', ') && !payload.includes(': '));
    assert.deepStrictEqual(JSON.parse(payload), pointer);
  });

  void it('emit pointer writes file when env var is set', () => {
    process.env.LMNR_DEBUG_WRITE_LAST_RUN_TO_FILE = '1';
    const dir = makeTmpDir();
    process.cwd = () => dir;
    const pointer = buildPointer({
      traceId: 't',
      sessionId: 's',
      replayTraceId: 'r',
      cacheUntil: 2,
      debuggerUrl: 'https://www.lmnr.ai',
    });

    withCapturedConsole(() => emitPointer(pointer));

    const path = join(dir, POINTER_DIR, POINTER_FILE);
    assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf-8')), pointer);
  });

  void it('emit pointer does not write file without env var', () => {
    const dir = makeTmpDir();
    process.cwd = () => dir;
    const pointer = buildPointer({
      traceId: 't',
      sessionId: 's',
      replayTraceId: null,
      cacheUntil: 0,
      debuggerUrl: null,
    });

    withCapturedConsole(() => emitPointer(pointer));

    assert.strictEqual(existsSync(join(dir, POINTER_DIR, POINTER_FILE)), false);
  });

  void it('emit pointer is best-effort on unwritable dir', () => {
    // Point cwd at a path under a regular file, so mkdirSync(recursive) raises
    // ENOTDIR; emitPointer must still print and not throw.
    process.env.LMNR_DEBUG_WRITE_LAST_RUN_TO_FILE = '1';
    const dir = makeTmpDir();
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    process.cwd = () => filePath;
    const pointer = buildPointer({
      traceId: 't',
      sessionId: 's',
      replayTraceId: null,
      cacheUntil: 0,
      debuggerUrl: null,
    });

    const lines = withCapturedConsole(() => emitPointer(pointer)); // must not throw
    const out = lines.join('\n').trim();
    assert.ok(out.startsWith(CONSOLE_PREFIX));
  });
});
