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
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    sessionToken: 'session-token-value-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    accessToken: 'jwt.value.signature',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    sessionExpiresAt: '2099-01-08T00:00:00.000Z',
    userEmail: 'alice@example.com',
    userId: '11111111-1111-1111-1111-111111111111',
    createdAt: '2026-06-04T12:34:56.000Z',
    ...overrides,
  };
}

describe('credentials roundtrip', () => {
  it('writes then reads back the same shape', async () => {
    const profile = sampleProfile();
    const sample: StoredCredentials = {
      version: 1,
      active: profile.userId,
      profiles: { [profile.userId]: profile },
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
      active: profile.userId,
      profiles: { [profile.userId]: profile },
    });

    const stat = statSync(credentialsPath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(isWin)('preserves an existing 0o640 mode across overwrites', async () => {
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.userId,
      profiles: { [profile.userId]: profile },
    });
    // Simulate a user-set wider mode then rerun.
    chmodSync(credentialsPath(), 0o640);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o640);

    await writeCredentials({
      version: 1,
      active: profile.userId,
      profiles: {
        [profile.userId]: { ...profile, accessToken: 'rotated' },
      },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o640);
    const round = await readCredentials();
    expect(round?.profiles[profile.userId].accessToken).toBe('rotated');
  });

  it.skipIf(isWin)('keeps 0o600 across re-runs', async () => {
    const profile = sampleProfile();
    await writeCredentials({
      version: 1,
      active: profile.userId,
      profiles: { [profile.userId]: profile },
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    await writeCredentials({
      version: 1,
      active: profile.userId,
      profiles: {
        [profile.userId]: { ...profile, accessToken: 'rotated' },
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
      active: profile.userId,
      profiles: { [profile.userId]: profile },
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
    const p1 = sampleProfile({ userId: 'aaa', userEmail: 'one@x.com' });
    const after = await upsertProfile(p1);
    expect(after.active).toBe('aaa');
    expect(Object.keys(after.profiles)).toEqual(['aaa']);

    const p2 = sampleProfile({ userId: 'bbb', userEmail: 'two@x.com' });
    const after2 = await upsertProfile(p2);
    expect(after2.active).toBe('bbb');
    expect(Object.keys(after2.profiles).sort()).toEqual(['aaa', 'bbb']);
  });

  it('findProfile resolves by exact userId, exact email, and prefix>=8', () => {
    const a = sampleProfile({
      userId: 'aaaaaaaa-1111-1111-1111-111111111111',
      userEmail: 'alpha@x.com',
    });
    const b = sampleProfile({
      userId: 'aaaaaaaa-2222-2222-2222-222222222222',
      userEmail: 'beta@x.com',
    });
    const creds: StoredCredentials = {
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    };
    expect(findProfile(creds, a.userId)?.userEmail).toBe('alpha@x.com');
    expect(findProfile(creds, 'beta@x.com')?.userId).toBe(b.userId);
    // Both ids share 'aaaaaaaa' prefix — ambiguous so should return null.
    expect(findProfile(creds, 'aaaaaaaa')).toBeNull();
    // Unique prefix.
    expect(findProfile(creds, 'aaaaaaaa-1111')?.userEmail).toBe('alpha@x.com');
    // Short prefix below threshold.
    expect(findProfile(creds, 'aaa')).toBeNull();
    expect(findProfile(creds, 'does-not-exist')).toBeNull();
  });

  it('getActiveProfile returns the active or null', () => {
    const p = sampleProfile({ userId: 'x' });
    const creds: StoredCredentials = { version: 1, active: 'x', profiles: { x: p } };
    expect(getActiveProfile(creds)?.userId).toBe('x');
    const empty = emptyCredentials();
    expect(getActiveProfile(empty)).toBeNull();
  });
});
