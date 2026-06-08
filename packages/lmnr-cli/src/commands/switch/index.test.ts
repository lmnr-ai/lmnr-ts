import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ProfileEntry,
  readCredentials,
  writeCredentials,
} from '../../auth/credentials';
import { handleSwitch } from './index';

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
  scratch = mkdtempSync(join(tmpdir(), 'lmnr-switch-'));
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

describe('handleSwitch', () => {
  it('switches by exact userId', async () => {
    const a = profile({ userId: 'u-aaaa-1111-1111-1111-111111111111', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb-2222-2222-2222-222222222222', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleSwitch(b.userId);
    const after = await readCredentials();
    expect(after?.active).toBe(b.userId);
    expect(stdoutMock).toHaveBeenCalledWith('Switched to beta@x.com\n');
  });

  it('switches by exact email', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: 'u-aaaa',
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleSwitch('beta@x.com');
    const after = await readCredentials();
    expect(after?.active).toBe('u-bbbb');
  });

  it('switches by id prefix (>=8 chars, unique)', async () => {
    const a = profile({ userId: 'aaaaaaaa-1111-1111-1111-111111111111', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'bbbbbbbb-2222-2222-2222-222222222222', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleSwitch('bbbbbbbb');
    const after = await readCredentials();
    expect(after?.active).toBe(b.userId);
  });

  it('exits 1 when no profile matches', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await expect(handleSwitch('does-not-exist')).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining("No profile matching 'does-not-exist'"),
    );
  });

  it('exits 6 when not logged in', async () => {
    await expect(handleSwitch('anything')).rejects.toThrow('exit:6');
    expect(exitMock).toHaveBeenCalledWith(6);
  });
});
