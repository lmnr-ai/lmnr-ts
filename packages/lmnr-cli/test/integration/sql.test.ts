import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as http from 'http';
import { tmpdir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');

type CliResult = { stdout: string; stderr: string; exitCode: number };

// XDG_CONFIG_HOME pointing at a temp dir with a flat credentials.json so the
// user-token auth path resolves without a real login. The far-future expiry
// avoids any token refresh, so the stored access token is sent as-is.
let credsDir: string;

function writeCredentialsFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lmnr-cli-test-'));
  mkdirSync(path.join(dir, 'lmnr'), { recursive: true });
  writeFileSync(
    path.join(dir, 'lmnr', 'credentials.json'),
    JSON.stringify({
      version: 1,
      issuer: 'http://localhost:0',
      baseUrl: 'http://localhost:0',
      sessionToken: 'fake-session',
      accessToken: 'fake-jwt',
      accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
      userId: '00000000-0000-0000-0000-000000000000',
      userEmail: 'test@example.com',
      createdAt: '2024-01-01T00:00:00.000Z',
    }),
  );
  return dir;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      'npx', ['tsx', CLI_PATH, ...args],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          LMNR_LOG_LEVEL: 'silent',
          XDG_CONFIG_HOME: credsDir,
          LMNR_PROJECT_ID: 'fake-project',
        },
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

describe('sql CLI integration — with mock server', () => {
  let mockServer: http.Server;
  let mockPort: number;

  const mockRows = [
    { id: 'span-001', name: 'fetch-data' },
    { id: 'span-002', name: 'process-data' },
  ];

  beforeAll(async () => {
    credsDir = writeCredentialsFixture();
    mockServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url?.startsWith('/v1/cli/sql/query')) {
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
    if (credsDir) rmSync(credsDir, { recursive: true, force: true });
  });

  it('sql query --json returns JSON array of rows', async () => {
    const { stdout, exitCode } = await runCli([
      'sql', 'query', 'SELECT * FROM spans',
      '--json',
      '--base-url', `http://localhost:${mockPort}`,
      '--port', String(mockPort),
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBe('span-001');
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
    ]);

    await new Promise<void>((resolve) => errorServer.close(() => resolve()));

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBeDefined();
  });
});
