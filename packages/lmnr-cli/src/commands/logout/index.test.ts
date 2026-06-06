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
import { deriveRevokeEndpoint, handleLogout } from './index';

const SAVED_XDG = process.env.XDG_CONFIG_HOME;
let scratch: string;
let exitMock: ReturnType<typeof vi.spyOn>;
let stderrMock: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

function profile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    tokenEndpoint: 'http://localhost:3010/oauth/token',
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    accessToken: 't',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    refreshToken: 'rt',
    refreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
    tokenType: 'Bearer',
    scope: 'projects:rw',
    projectId: 'p-aaaa',
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
  // Stub global fetch so logout's best-effort revoke call doesn't try to
  // hit a real server. Default: 200 OK.
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
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleLogout(undefined, { all: true });
    expect(await readCredentials()).toBeNull();
  });

  it('removes a specific profile by id', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleLogout('p-bbbb');
    const after = await readCredentials();
    expect(after?.profiles['p-bbbb']).toBeUndefined();
    expect(after?.profiles['p-aaaa']).toBeDefined();
    // Active unchanged because we removed a non-active profile.
    expect(after?.active).toBe('p-aaaa');
    expect(stderrMock).toHaveBeenCalledWith('Logged out of beta.\n');
  });

  it('removes a profile by name', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleLogout('beta');
    const after = await readCredentials();
    expect(after?.profiles['p-bbbb']).toBeUndefined();
  });

  it('default-when-active: removes active, reassigns to most-recently-used', async () => {
    const olderTime = '2026-05-01T00:00:00.000Z';
    const newerTime = '2026-06-01T00:00:00.000Z';
    const active = profile({ projectId: 'p-active', projectName: 'act' });
    const older = profile({
      projectId: 'p-older',
      projectName: 'old',
      lastUsedAt: olderTime,
    });
    const newer = profile({
      projectId: 'p-newer',
      projectName: 'new',
      lastUsedAt: newerTime,
    });
    await writeCredentials({
      version: 1,
      active: 'p-active',
      profiles: {
        [active.projectId]: active,
        [older.projectId]: older,
        [newer.projectId]: newer,
      },
    });
    await handleLogout(undefined);
    const after = await readCredentials();
    expect(after?.profiles['p-active']).toBeUndefined();
    expect(after?.active).toBe('p-newer');
    expect(stderrMock).toHaveBeenCalledWith('Logged out of act.\n');
  });

  it('default-with-one-profile removes and deletes the file', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
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
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await expect(handleLogout('does-not-exist')).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('POSTs to revoke endpoint with refresh_token before deleting the profile', async () => {
    const a = profile({
      projectId: 'p-aaaa',
      projectName: 'alpha',
      refreshToken: 'super-secret-rt',
      tokenEndpoint: 'http://localhost:3010/oauth/token',
    });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await handleLogout('p-aaaa');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3010/oauth/revoke');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(init.body);
    expect(params.get('token')).toBe('super-secret-rt');
    expect(params.get('token_type_hint')).toBe('refresh_token');
    expect(await readCredentials()).toBeNull();
  });

  it('continues local logout even when revoke endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await handleLogout('p-aaaa');
    expect(await readCredentials()).toBeNull();
  });

  it('continues local logout when revoke endpoint throws (network down)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await handleLogout('p-aaaa');
    expect(await readCredentials()).toBeNull();
  });

  it('--all revokes every profile before deleting the file', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha', refreshToken: 'rt-a' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta', refreshToken: 'rt-b' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleLogout(undefined, { all: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokens = fetchMock.mock.calls.map((c) => {
      const params = new URLSearchParams(c[1].body);
      return params.get('token');
    });
    expect(tokens.sort()).toEqual(['rt-a', 'rt-b']);
    expect(await readCredentials()).toBeNull();
  });
});

describe('deriveRevokeEndpoint', () => {
  it('rewrites /oauth/token to /oauth/revoke', () => {
    expect(deriveRevokeEndpoint('http://localhost:3010/oauth/token')).toBe(
      'http://localhost:3010/oauth/revoke',
    );
  });

  it('rewrites a /token suffix even without /oauth prefix', () => {
    expect(deriveRevokeEndpoint('https://issuer.example.com/path/token')).toBe(
      'https://issuer.example.com/path/revoke',
    );
  });

  it('returns null when the endpoint is not /token-suffixed', () => {
    expect(deriveRevokeEndpoint('https://issuer.example.com/something-else')).toBeNull();
  });

  it('returns null when the URL is malformed', () => {
    expect(deriveRevokeEndpoint('not a url')).toBeNull();
  });
});
