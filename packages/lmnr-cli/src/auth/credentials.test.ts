import { mkdtempSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  type StoredCredentials,
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

describe('credentials roundtrip', () => {
  it('writes then reads back the same shape', async () => {
    const sample: StoredCredentials = {
      version: 1,
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
    };

    await writeCredentials(sample);

    const path = credentialsPath();
    expect(path.startsWith(scratch)).toBe(true);

    const round = await readCredentials();
    expect(round).toEqual(sample);
  });

  it.skipIf(isWin)('persists credentials with mode 0o600', async () => {
    const sample: StoredCredentials = {
      version: 1,
      tokenEndpoint: 'http://localhost:3010/oauth/token',
      issuer: 'http://localhost:3010',
      baseUrl: 'http://localhost:8010',
      accessToken: 'eyJ.fake.jwt',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'rt-fake',
      refreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'projects:rw',
      createdAt: '2026-06-04T12:34:56.000Z',
    };

    await writeCredentials(sample);

    const stat = statSync(credentialsPath());
    // strip file-type bits, keep permission bits only
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readCredentials returns null when no file exists', async () => {
    const c = await readCredentials();
    expect(c).toBeNull();
  });

  it('deleteCredentials returns false when no file exists, true after a write', async () => {
    expect(await deleteCredentials()).toBe(false);

    await writeCredentials({
      version: 1,
      tokenEndpoint: 'http://localhost:3010/oauth/token',
      issuer: 'http://localhost:3010',
      baseUrl: 'http://localhost:8010',
      accessToken: 'eyJ.fake.jwt',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'rt-fake',
      refreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'projects:rw',
      createdAt: '2026-06-04T12:34:56.000Z',
    });
    expect(await deleteCredentials()).toBe(true);
    expect(await readCredentials()).toBeNull();
  });
});
