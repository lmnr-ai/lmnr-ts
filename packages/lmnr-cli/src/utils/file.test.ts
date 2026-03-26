import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectFiles, loadFromPaths, printToConsole, writeToFile } from './file';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lmnr-test-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('collectFiles', () => {
  it('returns a single supported JSON file', async () => {
    const file = path.join(tmpDir, 'data.json');
    await fs.writeFile(file, '[]');
    const result = await collectFiles([file]);
    expect(result).toEqual([file]);
  });

  it('returns a single supported CSV file', async () => {
    const file = path.join(tmpDir, 'data.csv');
    await fs.writeFile(file, 'a,b\n1,2');
    const result = await collectFiles([file]);
    expect(result).toEqual([file]);
  });

  it('returns a single supported JSONL file', async () => {
    const file = path.join(tmpDir, 'data.jsonl');
    await fs.writeFile(file, '{"a":1}\n{"a":2}');
    const result = await collectFiles([file]);
    expect(result).toEqual([file]);
  });

  it('skips unsupported file extensions', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'hello');
    const result = await collectFiles([file]);
    expect(result).toEqual([]);
  });

  it('collects only supported files from a directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.json'), '[]');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'skip');
    await fs.writeFile(path.join(tmpDir, 'c.csv'), 'x,y');
    const result = await collectFiles([tmpDir]);
    expect(result.length).toBe(2);
    expect(result.some(f => f.endsWith('a.json'))).toBe(true);
    expect(result.some(f => f.endsWith('c.csv'))).toBe(true);
  });

  it('collects files recursively when flag is set', async () => {
    const sub = path.join(tmpDir, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(tmpDir, 'top.json'), '[]');
    await fs.writeFile(path.join(sub, 'nested.json'), '[]');

    const noRecurse = await collectFiles([tmpDir], false);
    expect(noRecurse.length).toBe(1);

    const withRecurse = await collectFiles([tmpDir], true);
    expect(withRecurse.length).toBe(2);
  });

  it('returns empty for non-existent path', async () => {
    const result = await collectFiles(['/nonexistent/path/abc123']);
    expect(result).toEqual([]);
  });
});

describe('loadFromPaths', () => {
  it('loads JSON file with array contents', async () => {
    const file = path.join(tmpDir, 'data.json');
    await fs.writeFile(file, JSON.stringify([{ data: { x: 1 } }, { data: { x: 2 } }]));
    const result = await loadFromPaths([file]);
    expect(result.length).toBe(2);
    expect(result[0].data).toEqual({ x: 1 });
  });

  it('wraps single JSON object in array', async () => {
    const file = path.join(tmpDir, 'single.json');
    await fs.writeFile(file, JSON.stringify({ data: { name: 'test' } }));
    const result = await loadFromPaths([file]);
    expect(result.length).toBe(1);
    expect(result[0].data).toEqual({ name: 'test' });
  });

  it('loads CSV file as objects', async () => {
    const file = path.join(tmpDir, 'data.csv');
    await fs.writeFile(file, 'name,value\nalice,42\nbob,99');
    const result = await loadFromPaths([file]);
    expect(result.length).toBe(2);
    expect((result[0] as any).name).toBe('alice');
    expect((result[0] as any).value).toBe('42');
  });

  it('loads JSONL file line by line', async () => {
    const file = path.join(tmpDir, 'data.jsonl');
    await fs.writeFile(file, '{"data":{"a":1}}\n{"data":{"a":2}}\n{"data":{"a":3}}');
    const result = await loadFromPaths([file]);
    expect(result.length).toBe(3);
    expect(result[2].data).toEqual({ a: 3 });
  });

  it('returns empty for no supported files', async () => {
    const file = path.join(tmpDir, 'readme.txt');
    await fs.writeFile(file, 'nothing');
    const result = await loadFromPaths([file]);
    expect(result).toEqual([]);
  });
});

describe('writeToFile', () => {
  it('writes and reads back JSON', async () => {
    const file = path.join(tmpDir, 'out.json');
    const data = [{ data: { x: 1 }, target: { y: 2 } }];
    await writeToFile(file, data);
    const content = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('writes and reads back JSONL', async () => {
    const file = path.join(tmpDir, 'out.jsonl');
    const data = [{ data: { a: 1 } }, { data: { a: 2 } }];
    await writeToFile(file, data);
    const lines = (await fs.readFile(file, 'utf-8')).trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual(data[0]);
    expect(JSON.parse(lines[1])).toEqual(data[1]);
  });

  it('writes CSV', async () => {
    const file = path.join(tmpDir, 'out.csv');
    const data = [
      { data: { name: 'alice' }, target: { score: 10 } },
      { data: { name: 'bob' }, target: { score: 20 } },
    ];
    await writeToFile(file, data);
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('data');
    expect(content).toContain('target');
  });

  it('creates parent directories if missing', async () => {
    const file = path.join(tmpDir, 'nested', 'deep', 'out.json');
    await writeToFile(file, [{ data: 'test' }]);
    const content = await fs.readFile(file, 'utf-8');
    expect(JSON.parse(content)).toEqual([{ data: 'test' }]);
  });

  it('throws for unsupported format', async () => {
    const file = path.join(tmpDir, 'out.xml');
    await expect(writeToFile(file, [{ data: 1 }])).rejects.toThrow(/Unsupported output format/);
  });
});

describe('printToConsole', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('prints JSON with indentation', () => {
    const data = [{ data: { x: 1 } }];
    printToConsole(data, 'json');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it('prints JSONL one item per line', () => {
    const data = [{ data: { a: 1 } }, { data: { a: 2 } }];
    printToConsole(data, 'jsonl');
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data[0]));
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data[1]));
  });

  it('prints CSV', () => {
    const data = [{ data: { name: 'alice' }, target: { score: 10 } }];
    printToConsole(data, 'csv');
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('data');
    expect(output).toContain('target');
  });

  it('throws for unsupported format', () => {
    expect(() => printToConsole([], 'xml' as any)).toThrow(/Unsupported output format/);
  });
});
