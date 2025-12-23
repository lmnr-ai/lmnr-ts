import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert';
import { SqlResource } from '../src/client/resources/sql';

describe('SQL Resource Tests', () => {
  it('should send POST request to correct endpoint', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => [{ column1: 'value1' }],
    }));

    global.fetch = mockFetch as any;

    const sql = new SqlResource('https://api.test.com:443', 'test-api-key');
    const query = 'SELECT * FROM spans';

    await sql.query(query);

    assert.strictEqual(mockFetch.mock.calls.length, 1);
    const call = mockFetch.mock.calls[0];
    assert.strictEqual((call.arguments as any)[0], 'https://api.test.com:443/v1/sql/query');

    const requestOptions = (call.arguments as any)[1] as RequestInit;
    assert.strictEqual(requestOptions.method, 'POST');

    const body = JSON.parse(requestOptions.body as string);
    assert.strictEqual(body.query, query);
  });

  it('should parse response array correctly', async () => {
    const mockResponse = [
      { name: 'span1', output: '{"result": "test"}' },
      { name: 'span2', output: '{"result": "test2"}' },
    ];

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    }));

    global.fetch = mockFetch as any;

    const sql = new SqlResource('https://api.test.com:443', 'test-api-key');
    const result = await sql.query('SELECT * FROM spans');

    assert.deepStrictEqual(result, mockResponse);
  });

  it('should handle error responses', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    }));

    global.fetch = mockFetch as any;

    const sql = new SqlResource('https://api.test.com:443', 'test-api-key');

    await assert.rejects(
      async () => {
        await sql.query('INVALID QUERY');
      },
      /400/
    );
  });
});
