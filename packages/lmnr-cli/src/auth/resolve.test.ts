import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from './credentials';

// Mock the surfaces resolveAuth depends on. vi.mock factories are hoisted, so
// shared mocks live in vi.hoisted().
const { mockReadCredentials, mockReadProjectLink, mockMintAccessJwt, mockWriteCredentials } =
  vi.hoisted(() => ({
    mockReadCredentials: vi.fn(),
    mockReadProjectLink: vi.fn(),
    mockMintAccessJwt: vi.fn(),
    mockWriteCredentials: vi.fn(),
  }));

vi.mock('./credentials', () => ({
  readCredentials: mockReadCredentials,
  writeCredentials: mockWriteCredentials,
}));

vi.mock('../utils/project-link', () => ({
  readProjectLink: mockReadProjectLink,
}));

vi.mock('./device', () => ({
  mintAccessJwt: mockMintAccessJwt,
  // Far-future exp so refreshIfNeeded never re-mints in these tests.
  decodeJwtExp: () => '2099-01-01T00:00:00.000Z',
  DeviceFlowError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

import { refreshIfNeeded, resolveAuth } from './resolve';

const freshCreds: Credentials = {
  version: 1,
  issuer: 'http://localhost',
  baseUrl: 'http://localhost',
  sessionToken: 'sess',
  accessToken: 'jwt',
  // Far future → no refresh.
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'u1',
  createdAt: '2024-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReadCredentials.mockResolvedValue(freshCreds);
  mockReadProjectLink.mockResolvedValue(undefined);
  delete process.env.LMNR_PROJECT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LMNR_PROJECT_ID;
});

describe('resolveAuth project resolution', () => {
  it('uses the --project-id option', async () => {
    const auth = await resolveAuth({ projectId: 'flag-proj' });
    expect(auth.projectId).toBe('flag-proj');
  });

  it('falls back to the .lmnr/project.json link', async () => {
    mockReadProjectLink.mockResolvedValue({ projectId: 'linked-proj' });
    const auth = await resolveAuth({});
    expect(auth.projectId).toBe('linked-proj');
  });

  it('IGNORES LMNR_PROJECT_ID env entirely', async () => {
    process.env.LMNR_PROJECT_ID = 'env-proj';
    // No flag, no link → must error rather than pick up the env var.
    await expect(resolveAuth({})).rejects.toThrow('No project for this directory');
  });

  it('does not mention LMNR_PROJECT_ID in the no-project error', async () => {
    await expect(resolveAuth({})).rejects.not.toThrow(/LMNR_PROJECT_ID/);
  });
});

describe('refreshIfNeeded (logout race guard)', () => {
  it('does NOT write credentials for a fresh (not-near-expiry) token', async () => {
    const result = await refreshIfNeeded(freshCreds);

    expect(mockWriteCredentials).not.toHaveBeenCalled();
    expect(mockMintAccessJwt).not.toHaveBeenCalled();
    expect(result.accessToken).toBe('jwt');
  });

  it('re-mints AND writes credentials when the token is near expiry', async () => {
    mockMintAccessJwt.mockResolvedValue('fresh-jwt');
    const expiring: Credentials = {
      ...freshCreds,
      accessTokenExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    };

    const result = await refreshIfNeeded(expiring);

    expect(mockMintAccessJwt).toHaveBeenCalledTimes(1);
    expect(mockWriteCredentials).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe('fresh-jwt');
  });
});
