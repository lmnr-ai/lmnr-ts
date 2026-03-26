import { execFile } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { promisify } from 'util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');

type CliResult = { stdout: string; stderr: string; exitCode: number };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      'npx', ['tsx', CLI_PATH, ...args],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, LMNR_LOG_LEVEL: 'silent' },
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code ?? 1,
    };
  }
}

describe('sql CLI integration — validation errors', () => {
  it('sql query --json with invalid --parameters outputs JSON error', async () => {
    const { stdout, exitCode } = await runCli([
      'sql', 'query', 'SELECT * FROM spans',
      '--json', '--parameters', 'not-json',
      '--project-api-key', 'fake',
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toContain('--parameters must be valid JSON');
  });
});

describe('sql CLI integration — with mock server', () => {
  let mockServer: http.Server;
  let mockPort: number;

  const mockRows = [
    { id: 'span-001', name: 'fetch-data' },
    { id: 'span-002', name: 'process-data' },
  ];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url?.startsWith('/v1/sql/query')) {
          res.writeHead(200);
          res.end(JSON.stringify({ data: mockRows }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        mockPort = (mockServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it('sql query --json returns JSON array of rows', async () => {
    const { stdout, exitCode } = await runCli([
      'sql', 'query', 'SELECT * FROM spans',
      '--json',
      '--base-url', `http://localhost:${mockPort}`,
      '--port', String(mockPort),
      '--project-api-key', 'fake-key',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBe('span-001');
  });

  it('sql query forwards --parameters to the server', async () => {
    let capturedBody = '';

    const paramsServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        capturedBody = body;
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ data: [] }));
      });
    });

    const paramsPort = await new Promise<number>((resolve) => {
      paramsServer.listen(0, () => {
        resolve((paramsServer.address() as any).port);
      });
    });

    await runCli([
      'sql', 'query', 'SELECT * FROM spans WHERE id = :id',
      '--json',
      '--parameters', '{"id": "span-001"}',
      '--base-url', `http://localhost:${paramsPort}`,
      '--port', String(paramsPort),
      '--project-api-key', 'fake-key',
    ]);

    await new Promise<void>((resolve) => paramsServer.close(() => resolve()));

    const body = JSON.parse(capturedBody);
    expect(body.parameters).toEqual({ id: 'span-001' });
  });

  it('server error in --json mode exits non-zero with JSON error', async () => {
    const errorServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'internal server error' }));
      });
    });

    const errorPort = await new Promise<number>((resolve) => {
      errorServer.listen(0, () => {
        resolve((errorServer.address() as any).port);
      });
    });

    const { stdout, exitCode } = await runCli([
      'sql', 'query', 'SELECT * FROM spans',
      '--json',
      '--base-url', `http://localhost:${errorPort}`,
      '--port', String(errorPort),
      '--project-api-key', 'fake-key',
    ]);

    await new Promise<void>((resolve) => errorServer.close(() => resolve()));

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBeDefined();
  });
});
