import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  credentialsPath,
  deleteCredentials,
  emptyCredentials,
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
  upsertProfile,
  writeCredentials,
} from './credentials';

const isWin = process.platform === 'win32';
const SAVED_XDG = process.env.XDG_CONFIG_HOME;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lmnr-cli-creds-'));
  process.env.XDG_CONFIG_HOME = scratch;
});

afterEach(async () => {
  if (SAVED_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = SAVED_XDG;
  }
  await rm(scratch, { recursive: true, force: true });
});

function sampleProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    tokenEndpoint: 'http://localhost:3010/oauth/token',
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    accessToken: 'eyJ.fake.jwt',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    refreshToken: 'rt-fake',
    refreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
    tokenType: 'Bearer',
    scope: 'projects:rw',
    userEmail: 'alice@example.com',
    userId: '11111111-1111-1111-1111-111111111111',
    projectId: '00000000-0000-0000-0000-000000000000',
    projectName: 'my-project',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    workspaceName: "Alice's Workspace",
    createdAt: '2026-06-04T12:34:56.000Z',
    ...overrides,
  };
}

describe('credentials roundtrip', () => {
  it('writes then reads back the same shape', async () => {
    const profile = sampleProfile();
    const sample: StoredCredentials = {
      version: 1,
      active: profile.projectId,
      profiles: { [profile.projectId]: profile },
    };

    await writeCredentials(sample);

    const path = credentialsPath();
    expect(path.startsWith(scratch)).toBe(true);

    const round = await readCredentials();
    expect(round).toEqual(sample);
  });

  it.skipIf(isWin)('persists credentials with mode 0o600', async () => {
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: { [profile.projectId]: profile },
    });

    const stat = statSync(credentialsPath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(isWin)('preserves an existing 0o640 mode across overwrites', async () => {
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: { [profile.projectId]: profile },
    });
    // Simulate a user-set wider mode then rerun.
    chmodSync(credentialsPath(), 0o640);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o640);

    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: {
        [profile.projectId]: { ...profile, accessToken: 'rotated' },
      },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o640);
    const round = await readCredentials();
    expect(round?.profiles[profile.projectId].accessToken).toBe('rotated');
  });

  it.skipIf(isWin)('keeps 0o600 across re-runs', async () => {
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: { [profile.projectId]: profile },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: {
        [profile.projectId]: { ...profile, accessToken: 'rotated' },
      },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('readCredentials returns null when no file exists', async () => {
    const c = await readCredentials();
    expect(c).toBeNull();
  });

  it('deleteCredentials returns false when no file exists, true after a write', async () => {
    expect(await deleteCredentials()).toBe(false);
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.projectId,
      profiles: { [profile.projectId]: profile },
    });
    expect(await deleteCredentials()).toBe(true);
    expect(await readCredentials()).toBeNull();
  });

  it('readCredentials rejects unknown versions', async () => {
    await mkdir(dirname(credentialsPath()), { recursive: true, mode: 0o700 });
    await writeFile(credentialsPath(), JSON.stringify({ version: 99 }, null, 2), { mode: 0o600 });
    await expect(readCredentials()).rejects.toThrow(/Unsupported credentials file version/);
  });
});

describe('profile helpers', () => {
  it('upsertProfile inserts and marks active', async () => {
    const p1 = sampleProfile({ projectId: 'aaa', projectName: 'one' });
    const after = await upsertProfile(p1);
    expect(after.active).toBe('aaa');
    expect(Object.keys(after.profiles)).toEqual(['aaa']);

    const p2 = sampleProfile({ projectId: 'bbb', projectName: 'two' });
    const after2 = await upsertProfile(p2);
    expect(after2.active).toBe('bbb');
    expect(Object.keys(after2.profiles).sort()).toEqual(['aaa', 'bbb']);
  });

  it('findProfile resolves by exact id, exact name, and prefix>=8', () => {
    const a = sampleProfile({
      projectId: 'aaaaaaaa-1111-1111-1111-111111111111',
      projectName: 'alpha',
    });
    const b = sampleProfile({
      projectId: 'aaaaaaaa-2222-2222-2222-222222222222',
      projectName: 'beta',
    });
    const creds: StoredCredentials = {
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    };
    expect(findProfile(creds, a.projectId)?.projectName).toBe('alpha');
    expect(findProfile(creds, 'beta')?.projectId).toBe(b.projectId);
    // Both ids share 'aaaaaaaa' prefix — ambiguous so should return null.
    expect(findProfile(creds, 'aaaaaaaa')).toBeNull();
    // Unique prefix.
    expect(findProfile(creds, 'aaaaaaaa-1111')?.projectName).toBe('alpha');
    // Short prefix below threshold.
    expect(findProfile(creds, 'aaa')).toBeNull();
    expect(findProfile(creds, 'does-not-exist')).toBeNull();
  });

  it('getActiveProfile returns the active or null', () => {
    const p = sampleProfile({ projectId: 'x' });
    const creds: StoredCredentials = { version: 1, active: 'x', profiles: { x: p } };
    expect(getActiveProfile(creds)?.projectId).toBe('x');
    const empty = emptyCredentials();
    expect(getActiveProfile(empty)).toBeNull();
  });
});
