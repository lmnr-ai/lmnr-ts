import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '../../auth/credentials';

// vi.mock factories are hoisted — shared mocks live in vi.hoisted().
const { mockReadCredentials, mockDeleteCredentials } = vi.hoisted(() => ({
  mockReadCredentials: vi.fn(),
  mockDeleteCredentials: vi.fn(),
}));

vi.mock('../../auth/credentials', () => ({
  readCredentials: mockReadCredentials,
  deleteCredentials: mockDeleteCredentials,
  credentialsPath: () => '/tmp/creds.json',
}));

import { handleLogout } from './index';

const creds: Credentials = {
  version: 1,
  issuer: 'http://localhost',
  baseUrl: 'http://localhost',
  sessionToken: 'sess',
  accessToken: 'jwt',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'u1',
  userEmail: 'test@example.com',
  createdAt: '2024-01-01T00:00:00.000Z',
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockReadCredentials.mockResolvedValue(creds);
  mockDeleteCredentials.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleLogout', () => {
  it('deletes the credentials file BEFORE attempting the server revoke', async () => {
    const order: string[] = [];
    mockDeleteCredentials.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve(true);
    });
    fetchSpy = vi.fn(() => {
      order.push('revoke');
      return Promise.resolve({ ok: true } as Response);
    });
    global.fetch = fetchSpy as any;

    await handleLogout();

    expect(order).toEqual(['delete', 'revoke']);
  });

  it('removes the file even when the server revoke rejects', async () => {
    fetchSpy = vi.fn(() => Promise.reject(new Error('network down')));
    global.fetch = fetchSpy as any;

    await expect(handleLogout()).resolves.toBeUndefined();
    expect(mockDeleteCredentials).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already logged out', async () => {
    mockReadCredentials.mockResolvedValue(null);

    await handleLogout();

    expect(mockDeleteCredentials).not.toHaveBeenCalled();
  });
});
