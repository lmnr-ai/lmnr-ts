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
import { handleLogout } from './index';

const SAVED_XDG = process.env.XDG_CONFIG_HOME;
let scratch: string;
let exitMock: ReturnType<typeof vi.spyOn>;
let stderrMock: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

function profile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    sessionToken: 'session-token',
    accessToken: 'jwt-value',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    sessionExpiresAt: '2099-01-08T00:00:00.000Z',
    userId: 'u-aaaa',
    userEmail: 'alpha@x.com',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lmnr-logout-'));
  process.env.XDG_CONFIG_HOME = scratch;
  exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Stub global fetch so logout's best-effort session revoke call doesn't try
  // to hit a real server. Default: 200 OK.
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe('handleLogout', () => {
  it('--all removes the entire file', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleLogout(undefined, { all: true });
    expect(await readCredentials()).toBeNull();
  });

  it('removes a specific profile by userId', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleLogout('u-bbbb');
    const after = await readCredentials();
    expect(after?.profiles['u-bbbb']).toBeUndefined();
    expect(after?.profiles['u-aaaa']).toBeDefined();
    // Active unchanged because we removed a non-active profile.
    expect(after?.active).toBe('u-aaaa');
    expect(stderrMock).toHaveBeenCalledWith('Logged out of beta@x.com.\n');
  });

  it('removes a profile by email', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleLogout('beta@x.com');
    const after = await readCredentials();
    expect(after?.profiles['u-bbbb']).toBeUndefined();
  });

  it('default-when-active: removes active, reassigns to most-recently-used', async () => {
    const olderTime = '2026-05-01T00:00:00.000Z';
    const newerTime = '2026-06-01T00:00:00.000Z';
    const active = profile({ userId: 'u-active', userEmail: 'act@x.com' });
    const older = profile({
      userId: 'u-older',
      userEmail: 'old@x.com',
      lastUsedAt: olderTime,
    });
    const newer = profile({
      userId: 'u-newer',
      userEmail: 'new@x.com',
      lastUsedAt: newerTime,
    });
    await writeCredentials({
      version: 1,
      active: 'u-active',
      profiles: {
        [active.userId]: active,
        [older.userId]: older,
        [newer.userId]: newer,
      },
    });
    await handleLogout(undefined);
    const after = await readCredentials();
    expect(after?.profiles['u-active']).toBeUndefined();
    expect(after?.active).toBe('u-newer');
    expect(stderrMock).toHaveBeenCalledWith('Logged out of act@x.com.\n');
  });

  it('default-with-one-profile removes and deletes the file', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await handleLogout(undefined);
    expect(await readCredentials()).toBeNull();
  });

  it('not-logged-in path prints message', async () => {
    await handleLogout(undefined);
    expect(stderrMock).toHaveBeenCalledWith('Already logged out.\n');
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('exits 1 when target does not match', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await expect(handleLogout('does-not-exist')).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('POSTs sign-out with the session token before removing the profile', async () => {
    const a = profile({
      userId: 'u-aaaa',
      userEmail: 'alpha@x.com',
      sessionToken: 'secret-session',
    });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await handleLogout('u-aaaa');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3010/api/auth/sign-out');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret-session');
    expect(init.body).toBe('{}');
    expect(await readCredentials()).toBeNull();
  });

  it('skips server-side revoke when sessionToken is missing', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com', sessionToken: '' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await handleLogout('u-aaaa');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readCredentials()).toBeNull();
  });

  it('continues local logout even when revoke endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await handleLogout('u-aaaa');
    expect(await readCredentials()).toBeNull();
  });

  it('continues local logout when revoke endpoint throws (network down)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await handleLogout('u-aaaa');
    expect(await readCredentials()).toBeNull();
  });

  it('--all revokes every session before deleting the file', async () => {
    const a = profile({ userId: 'u-aaaa', userEmail: 'alpha@x.com', sessionToken: 's-a' });
    const b = profile({ userId: 'u-bbbb', userEmail: 'beta@x.com', sessionToken: 's-b' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await handleLogout(undefined, { all: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokens = fetchMock.mock.calls
      .map((c) => (c[1] as RequestInit).headers as Record<string, string>)
      .map((h) => h.authorization)
      .sort();
    expect(tokens).toEqual(['Bearer s-a', 'Bearer s-b']);
    expect(await readCredentials()).toBeNull();
  });
});
