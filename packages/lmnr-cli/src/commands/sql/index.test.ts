import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSqlQuery } from './index';

const mockQuery = vi.fn();

// handleSqlQuery is now a pure handler: the wrapper resolves the client and
// owns the error envelope. We pass a stub client with the sql surface directly.
const stubClient = { sql: { query: mockQuery } } as unknown as LaminarClient;

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleSqlQuery', () => {
  // --- --json mode ---

  it('outputs JSON array of rows in json mode', async () => {
    const rows = [{ id: '1', name: 'alice' }, { id: '2', name: 'bob' }];
    mockQuery.mockResolvedValue(rows);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(rows));
  });

  it('outputs empty JSON array when no rows in json mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  // --- Human mode ---

  it('prints column headers', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
  });

  it('separates columns with spacing', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    // Strip ANSI codes then check column spacing
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/id\s+name/);
  });

  it('prints each row', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('alice');
    expect(output).toContain('bob');
  });

  it('prints row count summary', async () => {
    mockQuery.mockResolvedValue([{ id: '1' }, { id: '2' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('2 row(s)');
  });

  it('prints "No rows returned." when result is empty', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(logSpy).toHaveBeenCalledWith('No rows returned.');
  });

  // --- Error handling ---
  // The handler no longer owns try/catch — it throws and the wrapper renders
  // the error envelope (see with-client.test.ts). Here we assert it propagates.

  it('propagates query errors to the wrapper', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    await expect(
      handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts),
    ).rejects.toThrow('connection refused');
  });
});
