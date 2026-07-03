import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  findDebugSessionDir,
  readDebugSessionFile,
  resolveDebugSessionDir,
  resolveSessionId,
  writeDebugSessionFile,
} from './debug-session-file';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TRACE_ID = '01234567-89ab-cdef-0123-456789abcdef';

let dir: string;

const writeRaw = (value: unknown) => {
  mkdirSync(join(dir, '.lmnr'), { recursive: true });
  writeFileSync(join(dir, '.lmnr', 'debug-session.json'), JSON.stringify(value), 'utf-8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lmnr-cli-debug-session-'));
});

describe('readDebugSessionFile', () => {
  it('round-trips what writeDebugSessionFile wrote', () => {
    const file = {
      session_id: SESSION_ID,
      trace_id: TRACE_ID,
      replay_trace_id: null,
      cache_until: null,
      debugger_url: 'https://laminar.sh/project/p/debugger-sessions/s',
      started_at: '2026-06-12T00:00:00.000Z',
    };
    expect(writeDebugSessionFile(file, dir)).toBe(true);
    expect(readDebugSessionFile(dir)).toEqual(file);
  });

  it('returns null on a missing file', () => {
    expect(readDebugSessionFile(dir)).toBeNull();
  });

  it('returns null on malformed JSON or a missing session_id', () => {
    mkdirSync(join(dir, '.lmnr'), { recursive: true });
    writeFileSync(join(dir, '.lmnr', 'debug-session.json'), 'not json', 'utf-8');
    expect(readDebugSessionFile(dir)).toBeNull();

    writeRaw({ trace_id: TRACE_ID });
    expect(readDebugSessionFile(dir)).toBeNull();
  });

  it('coerces non-string / empty fields to null', () => {
    writeRaw({ session_id: SESSION_ID, trace_id: 42, debugger_url: '' });
    const read = readDebugSessionFile(dir);
    expect(read?.session_id).toBe(SESSION_ID);
    expect(read?.trace_id).toBeNull();
    expect(read?.debugger_url).toBeNull();
  });
});

describe('findDebugSessionDir / resolveDebugSessionDir', () => {
  it('finds the file from a nested subdirectory by walking up', () => {
    writeRaw({ session_id: SESSION_ID });
    const nested = join(dir, 'packages', 'app');
    mkdirSync(nested, { recursive: true });

    expect(findDebugSessionDir(nested)).toBe(dir);
    expect(resolveDebugSessionDir(nested)).toBe(dir);
    expect(resolveSessionId(undefined, nested)).toBe(SESSION_ID);
  });

  it('prefers the nearest file when both a subdirectory and an ancestor have one', () => {
    writeRaw({ session_id: 'ancestor-session' });
    const nested = join(dir, 'sub');
    mkdirSync(join(nested, '.lmnr'), { recursive: true });
    writeFileSync(
      join(nested, '.lmnr', 'debug-session.json'),
      JSON.stringify({ session_id: 'nearest-session' }),
      'utf-8',
    );

    expect(findDebugSessionDir(nested)).toBe(nested);
    expect(resolveSessionId(undefined, nested)).toBe('nearest-session');
  });

  it('skips a malformed file and keeps walking to a valid ancestor', () => {
    writeRaw({ session_id: SESSION_ID });
    const nested = join(dir, 'sub');
    mkdirSync(join(nested, '.lmnr'), { recursive: true });
    writeFileSync(join(nested, '.lmnr', 'debug-session.json'), 'not json', 'utf-8');

    expect(findDebugSessionDir(nested)).toBe(dir);
  });

  it('resolves to the start directory itself when no ancestor has a file', () => {
    const nested = join(dir, 'sub');
    mkdirSync(nested, { recursive: true });
    expect(findDebugSessionDir(nested)).toBeNull();
    expect(resolveDebugSessionDir(nested)).toBe(nested);
  });
});

describe('resolveSessionId', () => {
  it('prefers the explicit argument over the file', () => {
    writeRaw({ session_id: SESSION_ID });
    expect(resolveSessionId('explicit-id', dir)).toBe('explicit-id');
  });

  it('falls back to the file session_id', () => {
    writeRaw({ session_id: SESSION_ID });
    expect(resolveSessionId(undefined, dir)).toBe(SESSION_ID);
  });

  it('throws an actionable error when neither exists', () => {
    expect(() => resolveSessionId(undefined, dir))
      .toThrow('No session id given');
  });
});

