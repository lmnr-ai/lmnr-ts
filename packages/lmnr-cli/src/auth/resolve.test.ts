import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
  writeCredentials,
} from './credentials';
import { resolveAuth } from './resolve';

// Far-future expiry so resolveAuth's near-expiry refresh path is NOT taken —
// the bearer is returned straight from accessToken with no network round-trip.
function freshProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    issuer: 'http://localhost:3010',
    baseUrl: 'http://localhost:8010',
    sessionToken: 'session-token',
    accessToken: 'fresh-jwt',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    sessionExpiresAt: '2099-01-08T00:00:00.000Z',
    userId: 'u-aaaa',
    userEmail: 'alpha@x.com',
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
  vi.unstubAllGlobals();
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
      active: a.userId,
      profiles: { [a.userId]: a },
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
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('env-key');
  });

  it('3. --project <email|userId> selects a specific profile', async () => {
    const a = freshProfile({ userId: 'u-aaaa', accessToken: 'jwt-a', userEmail: 'alpha@x.com' });
    const b = freshProfile({ userId: 'u-bbbb', accessToken: 'jwt-b', userEmail: 'beta@x.com' });
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    const r = await resolveAuth({ project: 'beta@x.com' });
    expect(r.bearer).toBe('jwt-b');
  });

  it('4. falls back to active profile', async () => {
    const a = freshProfile({ userId: 'u-aaaa', accessToken: 'jwt-a' });
    const b = freshProfile({ userId: 'u-bbbb', accessToken: 'jwt-b' });
    await writeCredentials({
      version: 1,
      active: 'u-bbbb',
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('jwt-b');
  });

  it('5. single-profile shortcut when active is unset', async () => {
    const a = freshProfile({ userId: 'u-aaaa', accessToken: 'only-jwt' });
    await writeCredentials({
      version: 1,
      active: null,
      profiles: { [a.userId]: a },
    });
    const r = await resolveAuth({});
    expect(r.bearer).toBe('only-jwt');
  });

  it('6. errors when multiple profiles and no selector', async () => {
    const a = freshProfile({ userId: 'u-aaaa' });
    const b = freshProfile({ userId: 'u-bbbb' });
    await writeCredentials({
      version: 1,
      active: null,
      profiles: { [a.userId]: a, [b.userId]: b },
    });
    await expect(resolveAuth({})).rejects.toThrow(/Multiple profiles/);
  });

  it('errors when --project does not match any profile', async () => {
    const a = freshProfile();
    await writeCredentials({
      version: 1,
      active: a.userId,
      profiles: { [a.userId]: a },
    });
    await expect(resolveAuth({ project: 'does-not-exist' })).rejects.toThrow(/No profile matching/);
  });

  it('errors when no credentials and no env / flag', async () => {
    await expect(resolveAuth({})).rejects.toThrow(/Not authenticated/);
  });
});

describe('resolveAuth JWT refresh', () => {
  it('re-mints the JWT when within ~30s of expiry and persists it', async () => {
    // exp in 10s → within the 30s skew → refresh fires.
    const nearExpiry = new Date(Date.now() + 10_000).toISOString();
    // A JWT whose payload.exp is ~1h out, base64url-encoded middle segment.
    const futureExpSec = Math.floor((Date.now() + 3_600_000) / 1000);
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSec })).toString('base64url');
    const newJwt = `header.${payload}.sig`;

    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ token: newJwt }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const a = freshProfile({
      userId: 'u-aaaa',
      accessToken: 'stale-jwt',
      accessTokenExpiresAt: nearExpiry,
    });
    await writeCredentials({ version: 1, active: a.userId, profiles: { [a.userId]: a } });

    const r = await resolveAuth({});
    expect(r.bearer).toBe(newJwt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3010/api/auth/token');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer session-token');

    // Persisted: the new JWT is stored back.
    const after = await readCredentials();
    expect(after?.profiles['u-aaaa'].accessToken).toBe(newJwt);
  });

  it('throws a clear login hint when the session is expired (401)', async () => {
    const nearExpiry = new Date(Date.now() + 5_000).toISOString();
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    vi.stubGlobal('fetch', fetchMock);

    const a = freshProfile({ userId: 'u-aaaa', accessTokenExpiresAt: nearExpiry });
    await writeCredentials({ version: 1, active: a.userId, profiles: { [a.userId]: a } });

    await expect(resolveAuth({})).rejects.toThrow(/Session expired/);
  });
});
