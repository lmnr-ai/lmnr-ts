import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSqlQuery } from './index';

const mockQuery = vi.fn();

// handleSqlQuery is now a pure handler: the wrapper resolves the client and
// owns the error envelope. We pass a stub client with the sql surface directly.
const stubClient = { sql: { query: mockQuery } } as unknown as LaminarClient;

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };

let logSpy: ReturnType<typeof vi.spyOn>;

const stdout = (): string =>
  (logSpy.mock.calls as unknown[][]).map((c) => c[0]).join('\n');

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

  // --- Default (CSV) mode ---

  it('outputs a CSV header row and one line per record by default', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    // Single stdout write: the whole CSV block (row count goes to stderr).
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('id,name\n1,alice\n2,bob');
  });

  it('quotes cells containing commas, quotes, or newlines', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', text: 'hello, world' },
      { id: '2', text: 'say "hi"' },
      { id: '3', text: 'line1\nline2' },
    ]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(stdout()).toBe(
      'id,text\n1,"hello, world"\n2,"say ""hi"""\n3,"line1\nline2"',
    );
  });

  it('serializes object/jsonb cells as a single JSON string cell', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', attributes: { model: 'gpt-4', nested: { a: 1 } } },
    ]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(stdout()).toBe(
      'id,attributes\n1,"{""model"":""gpt-4"",""nested"":{""a"":1}}"',
    );
  });

  it('renders null/undefined cells as empty fields', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: null }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(stdout()).toBe('id,name\n1,');
  });

  it('does not write a row-count summary to stdout in CSV mode', async () => {
    mockQuery.mockResolvedValue([{ id: '1' }, { id: '2' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(stdout()).not.toContain('row(s)');
  });

  it('writes nothing to stdout when no rows are returned (CSV mode)', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', baseOpts);

    expect(logSpy).not.toHaveBeenCalled();
  });

  // --- --pretty (table) mode ---

  it('prints column headers in pretty mode', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, pretty: true });

    const output = stdout();
    expect(output).toContain('id');
    expect(output).toContain('name');
  });

  it('separates columns with spacing in pretty mode', async () => {
    mockQuery.mockResolvedValue([{ id: '1', name: 'alice' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, pretty: true });

    // Strip ANSI codes then check column spacing
    // eslint-disable-next-line no-control-regex
    const plain = stdout().replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/id\s+name/);
  });

  it('prints each row in pretty mode', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, pretty: true });

    const output = stdout();
    expect(output).toContain('alice');
    expect(output).toContain('bob');
  });

  it('prints row count summary to stdout in pretty mode', async () => {
    mockQuery.mockResolvedValue([{ id: '1' }, { id: '2' }]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, pretty: true });

    expect(stdout()).toContain('2 row(s)');
  });

  it('prints "No rows returned." to stdout in pretty mode when empty', async () => {
    mockQuery.mockResolvedValue([]);

    await handleSqlQuery(stubClient, 'SELECT * FROM spans', { ...baseOpts, pretty: true });

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
