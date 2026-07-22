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

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

let credsDir: string;

// The signal endpoint lives on the APP-SERVER (`/v1/cli/signals`), authed with
// the user JWT and scoped by the `x-lmnr-project-id` header. `accessTokenExpiresAt`
// is far in the future so `resolveAuth` never tries to refresh (no issuer call),
// and the app-server URL is supplied per-test via `--base-url`.
function writeCredentialsFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lmnr-cli-signal-test-'));
  mkdirSync(path.join(dir, 'lmnr'), { recursive: true });
  writeFileSync(
    path.join(dir, 'lmnr', 'credentials.json'),
    JSON.stringify({
      version: 1,
      issuer: 'http://localhost:1',
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

describe('signal create CLI integration — with mock app-server', () => {
  let mockServer: http.Server;
  let baseUrl: string;
  let requests: { url: string; auth?: string; projectId?: string; body: any }[] = [];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/v1/cli/signals') {
          const body = JSON.parse(raw || '{}');
          const projectId = req.headers['x-lmnr-project-id'] as string | undefined;
          requests.push({ url: req.url, auth: req.headers.authorization, projectId, body });
          res.writeHead(200);
          res.end(JSON.stringify({
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            projectId,
            name: body.name,
            prompt: body.prompt,
            structuredOutput: body.structuredOutput,
            sampleRate: body.sampleRate ?? null,
            disabled: body.disabled ?? false,
            createdAt: '2026-01-01T00:00:00.000Z',
            triggers: (body.triggers ?? [{ filters: [], mode: 1 }]).map(
              (t: any, i: number) => ({
                id: `trigger-${i}`,
                filters: t.filters ?? [],
                mode: t.mode ?? 1,
              }),
            ),
          }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      mockServer.listen(0, () => resolve((mockServer.address() as any).port));
    });
    baseUrl = `http://localhost:${port}`;
    credsDir = writeCredentialsFixture();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { mockServer.close(() => resolve()); });
    if (credsDir) rmSync(credsDir, { recursive: true, force: true });
  });

  it('creates a signal with schema + trigger and emits JSON', async () => {
    requests = [];
    const { stdout, exitCode, stderr } = await runCli([
      'signal', 'create', 'My CLI Signal',
      '--prompt', 'Detect refund requests',
      '--schema', JSON.stringify({
        properties: {
          reason: { type: 'string', description: 'why' },
          severity: { type: 'string', description: 'level', enum: ['low', 'high'] },
        },
      }),
      '--trigger', JSON.stringify({
        filters: [{ column: 'total_token_count', operator: 'gt', value: 500 }],
      }),
      '--sample-rate', '25',
      '--project-id', PROJECT_ID,
      '--base-url', baseUrl,
      '--json',
    ]);

    expect(exitCode, stderr).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(parsed.name).toBe('My CLI Signal');

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    // User JWT bearer + project in the header (not the body).
    expect(sent.auth).toBe('Bearer fake-jwt');
    expect(sent.projectId).toBe(PROJECT_ID);
    expect('projectId' in sent.body).toBe(false);
    expect(sent.body.structuredOutput).toEqual({
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'why' },
        severity: { type: 'string', description: 'level', enum: ['low', 'high'] },
      },
      required: ['reason', 'severity'],
    });
    expect(sent.body.triggers).toEqual([
      { filters: [{ column: 'total_token_count', operator: 'gt', value: 500 }], mode: 1 },
    ]);
    expect(sent.body.sampleRate).toBe(25);
  });

  it('omits triggers when no --trigger is passed (server seeds default)', async () => {
    requests = [];
    const { exitCode } = await runCli([
      'signal', 'create', 'Defaults Signal',
      '--prompt', 'p',
      '--schema', JSON.stringify({ properties: { a: { type: 'string', description: '' } } }),
      '--project-id', PROJECT_ID,
      '--base-url', baseUrl,
      '--json',
    ]);
    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect('triggers' in requests[0].body).toBe(false);
    expect('sampleRate' in requests[0].body).toBe(false);
  });

  it('sends triggers: [] with --no-default-trigger', async () => {
    requests = [];
    const { exitCode } = await runCli([
      'signal', 'create', 'No Trigger Signal',
      '--prompt', 'p',
      '--schema', JSON.stringify({ properties: { a: { type: 'string', description: '' } } }),
      '--no-default-trigger',
      '--project-id', PROJECT_ID,
      '--base-url', baseUrl,
      '--json',
    ]);
    expect(exitCode).toBe(0);
    expect(requests[0].body.triggers).toEqual([]);
  });

  it('rejects an invalid schema locally without any network call', async () => {
    requests = [];
    const { stdout, exitCode } = await runCli([
      'signal', 'create', 'Bad Schema',
      '--prompt', 'p',
      '--schema', JSON.stringify({ properties: { 'bad-name': { type: 'string' } } }),
      '--project-id', PROJECT_ID,
      '--json',
    ]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout.trim()).error).toMatch(/valid identifier/);
    expect(requests).toHaveLength(0);
  });

  it('rejects an invalid trigger column locally without any network call', async () => {
    requests = [];
    const { stdout, exitCode } = await runCli([
      'signal', 'create', 'Bad Trigger',
      '--prompt', 'p',
      '--schema', JSON.stringify({ properties: { a: { type: 'string', description: '' } } }),
      '--trigger', JSON.stringify({ filters: [{ column: 'user_id', operator: 'eq', value: 'x' }] }),
      '--project-id', PROJECT_ID,
      '--json',
    ]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout.trim()).error).toMatch(/column must be one of/);
    expect(requests).toHaveLength(0);
  });

  it('surfaces a server error body in --json mode', async () => {
    const errorServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'A signal named "Dup" already exists in this project' }));
      });
    });
    const errorPort = await new Promise<number>((resolve) => {
      errorServer.listen(0, () => resolve((errorServer.address() as any).port));
    });

    const { stdout, exitCode } = await runCli([
      'signal', 'create', 'Dup',
      '--prompt', 'p',
      '--schema', JSON.stringify({ properties: { a: { type: 'string', description: '' } } }),
      '--project-id', PROJECT_ID,
      '--base-url', `http://localhost:${errorPort}`,
      '--json',
    ]);
    await new Promise<void>((resolve) => errorServer.close(() => resolve()));

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout.trim()).error).toMatch(/already exists/);
  });
});
