import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('@lmnr-ai/client', () => ({
  LaminarClient: class {
    sql = { query: mockQuery };
  },
}));

import { handleSqlQuery } from './index';

const baseOpts = { projectApiKey: 'fake-key', baseUrl: 'http://localhost', port: 8080 };

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code?) => {
    throw new Error(`process.exit(${code})`);
  });
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

    await handleSqlQuery('SELECT * FROM spans', { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(rows));
  });

  it('outputs empty JSON array when no rows in json mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery('SELECT * FROM spans', { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  // --- Human mode ---

  it('prints column headers', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery('SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('id');
    expect(output).toContain('name');
  });

  it('separates columns with spacing', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery('SELECT * FROM spans', baseOpts);

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

    await handleSqlQuery('SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('alice');
    expect(output).toContain('bob');
  });

  it('prints row count summary', async () => {
    mockQuery.mockResolvedValue([{ id: '1' }, { id: '2' }]);

    await handleSqlQuery('SELECT * FROM spans', baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('2 row(s)');
  });

  it('prints "No rows returned." when result is empty', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery('SELECT * FROM spans', baseOpts);

    expect(logSpy).toHaveBeenCalledWith('No rows returned.');
  });

  // --- Error handling ---

  it('outputs JSON error on API failure in json mode', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    await expect(
      handleSqlQuery('SELECT * FROM spans', { ...baseOpts, json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('connection refused');
  });

  it('exits 1 on API failure in human mode', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    await expect(
      handleSqlQuery('SELECT * FROM spans', baseOpts),
    ).rejects.toThrow('process.exit(1)');
  });
});
