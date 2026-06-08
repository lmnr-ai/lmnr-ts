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
    tokenEndpoint: 'http://localhost:3010/api/cli/device/poll',
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    accessToken: 'real-api-key',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshToken: '',
    refreshTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    tokenType: 'Bearer',
    scope: 'projects:rw',
    projectId: 'p-aaaa',
    apiKeyId: '11111111-1111-1111-1111-111111111111',
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

  it('DELETEs the project API key before removing the profile', async () => {
    const a = profile({
      projectId: 'p-aaaa',
      projectName: 'alpha',
      apiKeyId: 'aaaa-1111-2222-3333-bbbb',
      accessToken: 'secret-key',
    });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await handleLogout('p-aaaa');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3010/api/projects/p-aaaa/api-keys/aaaa-1111-2222-3333-bbbb');
    expect(init.method).toBe('DELETE');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    expect(await readCredentials()).toBeNull();
  });

  it('skips server-side revoke when apiKeyId is missing', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha', apiKeyId: undefined });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await handleLogout('p-aaaa');
    expect(fetchMock).not.toHaveBeenCalled();
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
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha', apiKeyId: 'k-a' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta', apiKeyId: 'k-b' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleLogout(undefined, { all: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual([
      'http://localhost:3010/api/projects/p-aaaa/api-keys/k-a',
      'http://localhost:3010/api/projects/p-bbbb/api-keys/k-b',
    ]);
    expect(await readCredentials()).toBeNull();
  });
});
