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
  it('switches by exact projectId', async () => {
    const a = profile({ projectId: 'p-aaaa-1111-1111-1111-111111111111', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb-2222-2222-2222-222222222222', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleSwitch(b.projectId);
    const after = await readCredentials();
    expect(after?.active).toBe(b.projectId);
    expect(stdoutMock).toHaveBeenCalledWith('Switched to beta\n');
  });

  it('switches by exact projectName', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    const b = profile({ projectId: 'p-bbbb', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: 'p-aaaa',
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleSwitch('beta');
    const after = await readCredentials();
    expect(after?.active).toBe('p-bbbb');
  });

  it('switches by id prefix (>=8 chars, unique)', async () => {
    const a = profile({ projectId: 'aaaaaaaa-1111-1111-1111-111111111111', projectName: 'alpha' });
    const b = profile({ projectId: 'bbbbbbbb-2222-2222-2222-222222222222', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await handleSwitch('bbbbbbbb');
    const after = await readCredentials();
    expect(after?.active).toBe(b.projectId);
  });

  it('exits 1 when no profile matches', async () => {
    const a = profile({ projectId: 'p-aaaa', projectName: 'alpha' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
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
