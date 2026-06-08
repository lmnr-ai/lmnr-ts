import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { type ProfileEntry, writeCredentials } from '../../auth/credentials';
import { handleList, relativeTime } from './index';

function collectStdout(mock: MockInstance): string {
  const calls = mock.mock.calls as unknown as Array<[string | Uint8Array]>;
  return calls.map((c) => String(c[0])).join('');
}

const SAVED_XDG = process.env.XDG_CONFIG_HOME;
let scratch: string;
let exitMock: ReturnType<typeof vi.spyOn>;
let stderrMock: ReturnType<typeof vi.spyOn>;
let stdoutMock: ReturnType<typeof vi.spyOn>;

function profile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    sessionToken: 'session-token',
    accessToken: 'jwt',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    sessionExpiresAt: '2030-01-08T00:00:00.000Z',
    userId: 'u-aaaa',
    userEmail: 'alpha@x.com',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lmnr-list-'));
  process.env.XDG_CONFIG_HOME = scratch;
  exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe('relativeTime', () => {
  const NOW = Date.parse('2026-06-05T12:00:00.000Z');
  it('returns "never" for undefined / unparseable', () => {
    expect(relativeTime(undefined, NOW)).toBe('never');
    expect(relativeTime('garbage', NOW)).toBe('never');
  });
  it('returns "just now" for <60s', () => {
    expect(relativeTime(new Date(NOW - 30 * 1000).toISOString(), NOW)).toBe('just now');
  });
  it('returns minutes ago for <60m', () => {
    expect(relativeTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe('5m ago');
  });
  it('returns hours ago for <24h', () => {
    expect(relativeTime(new Date(NOW - 2 * 3600 * 1000).toISOString(), NOW)).toBe('2h ago');
  });
  it('returns days ago for >=24h', () => {
    expect(relativeTime(new Date(NOW - 3 * 86400 * 1000).toISOString(), NOW)).toBe('3d ago');
  });
});

describe('handleList', () => {
  it('exits 6 with zero profiles', async () => {
    await expect(handleList()).rejects.toThrow('exit:6');
    expect(exitMock).toHaveBeenCalledWith(6);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('Not logged in.'),
    );
  });

  it('renders a single profile with an active marker', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({ version: 1, active: 'u-aaaa', profiles: { [a.userId]: a } });
    await handleList();
    const printed = collectStdout(stdoutMock);
    expect(printed).toContain('alpha@x.com');
    expect(printed).toContain('http://localhost:3010');
    // Active line starts with "* ".
    const lines = printed.split('\n');
    const activeAlpha = lines.some((l: string) => l.startsWith('* ') && l.includes('alpha@x.com'));
    expect(activeAlpha).toBe(true);
  });

  it('renders 3 profiles and marks only the active one', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com' });
    const c = profile({ userId: 'u-cccc', userEmail: 'gamma@x.com' });
    await writeCredentials({
      version: 1,
      active: 'u-bbbb',
      profiles: { [a.userId]: a, [b.userId]: b, [c.userId]: c },
    });
    await handleList();
    const printed = collectStdout(stdoutMock);
    const lines = printed.split('\n').filter((l: string) => l.length > 0);
    // header + 3 rows.
    expect(lines.length).toBe(4);
    const activeRows = lines.filter((l: string) => l.startsWith('* '));
    expect(activeRows.length).toBe(1);
    expect(activeRows[0]).toContain('beta@x.com');
    // alpha + gamma are inactive (leading "  ").
    const inactiveRows = lines.filter((l: string, i: number) => i > 0 && !l.startsWith('* '));
    expect(inactiveRows.length).toBe(2);
    expect(printed).toContain('alpha@x.com');
    expect(printed).toContain('gamma@x.com');
  });
});
