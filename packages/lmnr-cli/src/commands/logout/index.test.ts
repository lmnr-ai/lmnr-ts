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
});

afterEach(async () => {
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe('handleLogout', () => {
  it('--all removes the entire file', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta' });
    await writeCredentials({
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await expect(handleLogout('does-not-exist')).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
