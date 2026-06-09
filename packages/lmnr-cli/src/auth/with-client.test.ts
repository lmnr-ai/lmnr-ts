import type { LaminarClient } from '@lmnr-ai/client';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the client construction surfaces the wrappers depend on. vi.mock
// factories are hoisted, so the shared mocks must live in vi.hoisted().
const stubClient = { id: 'project-client' } as unknown as LaminarClient;
const { mockBuildLaminarClient, mockResolveUserToken, mockLaminarClientCtor } = vi.hoisted(
  () => ({
    mockBuildLaminarClient: vi.fn(),
    mockResolveUserToken: vi.fn(),
    mockLaminarClientCtor: vi.fn(),
  }),
);

vi.mock('./client', () => ({
  buildLaminarClient: mockBuildLaminarClient,
}));

vi.mock('./resolve', () => ({
  resolveUserToken: mockResolveUserToken,
}));

vi.mock('@lmnr-ai/client', () => ({
  // Must be constructable (`new LaminarClient(...)`), so use a class, not an
  // arrow function.
  LaminarClient: class {
    public id = 'user-token-client';
    constructor(args: unknown) {
      mockLaminarClientCtor(args);
    }
  },
}));

import { withProjectClient, withUserToken } from './with-client';

// Build a fake commander invocation: positionals followed by (options, command).
// The wrapper reads opts from cmd.optsWithGlobals().
function fakeCommand(opts: Record<string, unknown>): Command {
  return { optsWithGlobals: () => opts } as unknown as Command;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errLogSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code?) => {
    throw new Error(`process.exit(${code})`);
  });
  vi.clearAllMocks();
  mockBuildLaminarClient.mockResolvedValue(stubClient);
  mockResolveUserToken.mockResolvedValue({
    bearer: 'jwt-xyz',
    baseUrl: 'http://localhost',
    port: 8080,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withProjectClient', () => {
  it('resolves a client and threads positionals + opts to the action', async () => {
    const action = vi.fn(() => Promise.resolve());
    const opts = { projectId: 'p1', baseUrl: 'http://localhost', port: 8080, json: false };
    const cmd = fakeCommand(opts);

    // commander would call: action(positional, options, command)
    await withProjectClient(action)('the-query', {}, cmd);

    expect(mockBuildLaminarClient).toHaveBeenCalledWith({
      projectId: 'p1',
      baseUrl: 'http://localhost',
      port: 8080,
    });
    expect(action).toHaveBeenCalledWith(stubClient, 'the-query', opts);
  });

  it('renders a JSON error and exits with the mapped code on failure', async () => {
    const action = vi.fn(() => Promise.reject(new Error('boom')));
    const cmd = fakeCommand({ json: true });
    const exitCodeFor = () => 9;

    await expect(withProjectClient(action, exitCodeFor)({}, cmd)).rejects.toThrow(
      'process.exit(9)',
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('boom');
  });

  it('exits 1 by default in human mode on failure', async () => {
    const action = vi.fn(() => Promise.reject(new Error('boom')));
    const cmd = fakeCommand({ json: false });

    await expect(withProjectClient(action)({}, cmd)).rejects.toThrow('process.exit(1)');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errLogSpy).not.toHaveBeenCalled(); // logger writes to pino, not console
  });
});

describe('withUserToken', () => {
  it('builds a user-token discovery client (empty projectId) and threads opts', async () => {
    const action = vi.fn(() => Promise.resolve());
    const opts = { baseUrl: 'http://localhost', port: 8080, json: false };
    const cmd = fakeCommand(opts);

    await withUserToken(action)({}, cmd);

    expect(mockResolveUserToken).toHaveBeenCalledWith({
      baseUrl: 'http://localhost',
      port: 8080,
    });
    expect(mockLaminarClientCtor).toHaveBeenCalledWith({
      baseUrl: 'http://localhost',
      port: 8080,
      auth: { type: 'userToken', token: 'jwt-xyz', projectId: '' },
    });
    expect(action).toHaveBeenCalledWith({ id: 'user-token-client' }, opts);
  });

  it('renders a JSON error and exits on failure', async () => {
    const action = vi.fn(() => Promise.reject(new Error('discovery failed')));
    const cmd = fakeCommand({ json: true });

    await expect(withUserToken(action)({}, cmd)).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('discovery failed');
  });
});
