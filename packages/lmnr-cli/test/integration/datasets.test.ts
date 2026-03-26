import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

describe('datasets CLI integration — validation errors', () => {
  it('datasets push --json with no name/id outputs JSON error', async () => {
    const { stdout, exitCode } = await runCli([
      'datasets', 'push', '--json', '--project-api-key', 'fake', './nonexistent',
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('name or id');
  });

  it('datasets push --json with both name and id outputs JSON error', async () => {
    const { stdout, exitCode } = await runCli([
      'datasets', 'push', '--json', '--name', 'x', '--id', 'y',
      '--project-api-key', 'fake', './nonexistent',
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toContain('one of name or id');
  });

  it('datasets pull --json with no name/id outputs JSON error', async () => {
    const { stdout, exitCode } = await runCli([
      'datasets', 'pull', '--json', '--project-api-key', 'fake',
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toContain('name or id');
  });

  it('all --json error outputs are valid JSON', async () => {
    const results = await Promise.all([
      runCli(['datasets', 'push', '--json', '--project-api-key', 'fake', './x']),
      runCli(['datasets', 'pull', '--json', '--project-api-key', 'fake']),
    ]);

    for (const { stdout } of results) {
      const trimmed = stdout.trim();
      expect((): unknown => JSON.parse(trimmed)).not.toThrow();
    }
  });
});

describe('datasets CLI integration — with mock server', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let tmpDir: string;

  const mockDatasets = [
    { id: 'ds-001', name: 'test-dataset', createdAt: '2024-01-01T00:00:00Z' },
    { id: 'ds-002', name: 'another-dataset', createdAt: '2024-06-15T12:00:00Z' },
  ];

  const mockDatapoints = [
    { data: { text: 'hello' }, target: { label: 'greeting' }, id: 'dp-1' },
    { data: { text: 'bye' }, target: { label: 'farewell' }, id: 'dp-2' },
  ];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET' && req.url?.startsWith('/v1/datasets/datapoints')) {
          res.writeHead(200);
          res.end(JSON.stringify({ items: mockDatapoints, totalCount: mockDatapoints.length }));
        } else if (req.method === 'GET' && req.url?.startsWith('/v1/datasets')) {
          res.writeHead(200);
          res.end(JSON.stringify(mockDatasets));
        } else if (req.method === 'POST' && req.url?.startsWith('/v1/datasets/datapoints')) {
          res.writeHead(201);
          res.end(JSON.stringify({ datasetId: 'ds-new-001' }));
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

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `lmnr-int-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('datasets list --json returns JSON array', async () => {
    const { stdout, exitCode } = await runCli([
      'datasets', 'list', '--json',
      '--base-url', `http://localhost:${mockPort}`,
      '--port', String(mockPort),
      '--project-api-key', 'fake-key',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe('test-dataset');
  });

  it('datasets pull --json returns datapoints', async () => {
    const { stdout, exitCode } = await runCli([
      'datasets', 'pull', '--json', '--name', 'test-dataset',
      '--base-url', `http://localhost:${mockPort}`,
      '--port', String(mockPort),
      '--project-api-key', 'fake-key',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].data.text).toBe('hello');
  });

  it('datasets push --json returns success with count', async () => {
    // Create a temp data file
    const dataFile = path.join(tmpDir, 'push-data.json');
    await fs.writeFile(dataFile, JSON.stringify([{ data: { x: 1 } }, { data: { x: 2 } }]));

    const { stdout, exitCode } = await runCli([
      'datasets', 'push', '--json', '--name', 'test-dataset',
      '--base-url', `http://localhost:${mockPort}`,
      '--port', String(mockPort),
      '--project-api-key', 'fake-key',
      dataFile,
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.datasetId).toBe('ds-new-001');
    expect(parsed.count).toBe(2);
  });
});
