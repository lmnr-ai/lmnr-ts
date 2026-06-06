import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ProfileEntry,
  type StoredCredentials,
  writeCredentials,
} from './credentials';
import { resolveAuth } from './resolve';

// refreshIfNeeded does a network call when expiry is near. Keep tokens fresh
// in every fixture so resolveAuth never reaches the openid-client path.
function freshProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    tokenEndpoint: 'http://localhost:3010/oauth/token',
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    accessToken: 'fresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: 'rt',
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    tokenType: 'Bearer',
    scope: 'projects:rw',
    projectId: 'p-aaaa',
    projectName: 'alpha',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const SAVED_XDG = process.env.XDG_CONFIG_HOME;
const SAVED_KEY = process.env.LMNR_PROJECT_API_KEY;
const SAVED_PROJECT = process.env.LMNR_PROJECT_ID;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lmnr-resolve-'));
  process.env.XDG_CONFIG_HOME = scratch;
  delete process.env.LMNR_PROJECT_API_KEY;
  delete process.env.LMNR_PROJECT_ID;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
  if (SAVED_KEY === undefined) delete process.env.LMNR_PROJECT_API_KEY;
  else process.env.LMNR_PROJECT_API_KEY = SAVED_KEY;
  if (SAVED_PROJECT === undefined) delete process.env.LMNR_PROJECT_ID;
  else process.env.LMNR_PROJECT_ID = SAVED_PROJECT;
  await rm(scratch, { recursive: true, force: true });
});

describe('resolveAuth precedence', () => {
  it('1. --project-api-key flag wins', async () => {
    process.env.LMNR_PROJECT_API_KEY = 'env-key';
    const a = freshProfile();
    const creds: StoredCredentials = {
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    };
    await writeCredentials(creds);
    const r = await resolveAuth({ projectApiKey: 'flag-key' });
    expect(r.bearer).toBe('flag-key');
  });

  it('2. LMNR_PROJECT_API_KEY env beats credentials', async () => {
    process.env.LMNR_PROJECT_API_KEY = 'env-key';
    const a = freshProfile();
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('env-key');
  });

  it('3. --project <id> selects a specific profile', async () => {
    const a = freshProfile({ projectId: 'p-aaaa', accessToken: 'tok-a', projectName: 'alpha' });
    const b = freshProfile({ projectId: 'p-bbbb', accessToken: 'tok-b', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    const r = await resolveAuth({ project: 'beta' });
    expect(r.bearer).toBe('tok-b');
  });

  it('4. LMNR_PROJECT_ID env selects when no --project flag', async () => {
    const a = freshProfile({ projectId: 'p-aaaa', accessToken: 'tok-a' });
    const b = freshProfile({ projectId: 'p-bbbb', accessToken: 'tok-b', projectName: 'beta' });
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    process.env.LMNR_PROJECT_ID = 'p-bbbb';
    const r = await resolveAuth({});
    expect(r.bearer).toBe('tok-b');
  });

  it('5. falls back to active profile', async () => {
    const a = freshProfile({ projectId: 'p-aaaa', accessToken: 'tok-a' });
    const b = freshProfile({ projectId: 'p-bbbb', accessToken: 'tok-b' });
    await writeCredentials({
      version: 1,
      active: 'p-bbbb',
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('tok-b');
  });

  it('6. single-profile shortcut when active is unset', async () => {
    const a = freshProfile({ projectId: 'p-aaaa', accessToken: 'only-tok' });
    await writeCredentials({
      version: 1,
      active: null,
      profiles: { [a.projectId]: a },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('only-tok');
  });

  it('7. errors when multiple profiles and no selector', async () => {
    const a = freshProfile({ projectId: 'p-aaaa' });
    const b = freshProfile({ projectId: 'p-bbbb' });
    await writeCredentials({
      version: 1,
      active: null,
      profiles: { [a.projectId]: a, [b.projectId]: b },
    });
    await expect(resolveAuth({})).rejects.toThrow(/Multiple profiles/);
  });

  it('errors when --project does not match any profile', async () => {
    const a = freshProfile();
    await writeCredentials({
      version: 1,
      active: a.projectId,
      profiles: { [a.projectId]: a },
    });
    await expect(resolveAuth({ project: 'does-not-exist' })).rejects.toThrow(/No profile matching/);
  });

  it('errors when no credentials and no env / flag', async () => {
    await expect(resolveAuth({})).rejects.toThrow(/Not authenticated/);
  });
});
