import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock LaminarClient before importing handlers
const mockListDatasets = vi.fn();
const mockPush = vi.fn();
const mockPull = vi.fn();

vi.mock('@lmnr-ai/client', () => ({
  LaminarClient: class {
    datasets = {
      listDatasets: mockListDatasets,
      push: mockPush,
      pull: mockPull,
    };
  },
}));

vi.mock('../../utils/file', () => ({
  loadFromPaths: vi.fn(),
  writeToFile: vi.fn(),
  printToConsole: vi.fn(),
}));

// Import after mocks are set up
import { loadFromPaths, printToConsole, writeToFile } from '../../utils/file';
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from './index';

const mockedLoadFromPaths = vi.mocked(loadFromPaths);
const mockedWriteToFile = vi.mocked(writeToFile);
const mockedPrintToConsole = vi.mocked(printToConsole);

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

const baseOpts = { projectApiKey: 'fake-key', baseUrl: 'http://localhost', port: 8080 };

describe('handleDatasetsList', () => {
  it('outputs JSON array in json mode', async () => {
    const datasets = [{ id: 'abc-123', name: 'test-ds', createdAt: '2024-01-01T00:00:00Z' }];
    mockListDatasets.mockResolvedValue(datasets);

    await handleDatasetsList({ ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(datasets));
  });

  it('outputs empty JSON array in json mode when no datasets', async () => {
    mockListDatasets.mockResolvedValue([]);

    await handleDatasetsList({ ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('prints table in human mode', async () => {
    const datasets = [{ id: 'abc-123', name: 'test-ds', createdAt: '2024-01-01T00:00:00Z' }];
    mockListDatasets.mockResolvedValue(datasets);

    await handleDatasetsList(baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('ID');
    expect(output).toContain('test-ds');
    expect(output).toContain('Total: 1 dataset(s)');
  });

  it('prints "No datasets found." in human mode when empty', async () => {
    mockListDatasets.mockResolvedValue([]);

    await handleDatasetsList(baseOpts);

    expect(logSpy).toHaveBeenCalledWith('No datasets found.');
  });

  it('outputs JSON error on API failure in json mode', async () => {
    mockListDatasets.mockRejectedValue(new Error('unauthorized'));

    await expect(
      handleDatasetsList({ ...baseOpts, json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('unauthorized');
  });

  it('exits on API failure in human mode', async () => {
    mockListDatasets.mockRejectedValue(new Error('unauthorized'));

    await expect(handleDatasetsList(baseOpts)).rejects.toThrow('process.exit(1)');
  });
});

describe('handleDatasetsPush', () => {
  it('exits when neither name nor id provided', async () => {
    await expect(handleDatasetsPush([], { ...baseOpts })).rejects.toThrow('process.exit(1)');
  });

  it('exits when both name and id provided', async () => {
    await expect(
      handleDatasetsPush([], { ...baseOpts, name: 'x', id: 'y' as any }),
    ).rejects.toThrow('process.exit(1)');
  });

  it('outputs JSON error when no name/id in json mode', async () => {
    await expect(
      handleDatasetsPush([], { ...baseOpts, json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toContain('name or id');
  });

  it('exits with error when no data to push', async () => {
    mockedLoadFromPaths.mockResolvedValue([]);

    await expect(
      handleDatasetsPush(['./data'], { ...baseOpts, name: 'test' }),
    ).rejects.toThrow('process.exit(1)');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('outputs JSON on success in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });

    await handleDatasetsPush(['./data'], { ...baseOpts, name: 'test', json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.datasetId).toBe('ds-123');
    expect(output.count).toBe(1);
  });

  it('logs success in human mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });

    await handleDatasetsPush(['./data'], { ...baseOpts, name: 'test' });

    // No console.log for data — logger writes to stderr
    expect(mockPush).toHaveBeenCalled();
  });

  it('outputs JSON error on API failure in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockRejectedValue(new Error('server error'));

    await expect(
      handleDatasetsPush(['./data'], { ...baseOpts, name: 'test', json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('server error');
  });
});

describe('handleDatasetsPull', () => {
  it('exits when neither name nor id provided', async () => {
    await expect(handleDatasetsPull(undefined, { ...baseOpts })).rejects.toThrow('process.exit(1)');
  });

  it('exits when both name and id provided', async () => {
    await expect(
      handleDatasetsPull(undefined, { ...baseOpts, name: 'x', id: 'y' as any }),
    ).rejects.toThrow('process.exit(1)');
  });

  it('writes to file and outputs JSON confirmation in json mode', async () => {
    mockPull.mockResolvedValue({ items: [{ data: { a: 1 } }], totalCount: 1 });

    await handleDatasetsPull('/tmp/out.json', { ...baseOpts, name: 'test', json: true });

    expect(mockedWriteToFile).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.path).toBe('/tmp/out.json');
    expect(output.count).toBe(1);
  });

  it('writes to file and logs in human mode', async () => {
    mockPull.mockResolvedValue({ items: [{ data: { a: 1 } }], totalCount: 1 });

    await handleDatasetsPull('/tmp/out.json', { ...baseOpts, name: 'test' });

    expect(mockedWriteToFile).toHaveBeenCalled();
  });

  it('outputs data to stdout in json mode without output path', async () => {
    const items = [{ data: { a: 1 } }, { data: { a: 2 } }];
    mockPull.mockResolvedValue({ items, totalCount: 2 });

    await handleDatasetsPull(undefined, { ...baseOpts, name: 'test', json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toEqual(items);
  });

  it('calls printToConsole in human mode without output path', async () => {
    const items = [{ data: { a: 1 } }];
    mockPull.mockResolvedValue({ items, totalCount: 1 });

    await handleDatasetsPull(undefined, { ...baseOpts, name: 'test', outputFormat: 'jsonl' });

    expect(mockedPrintToConsole).toHaveBeenCalledWith(items, 'jsonl');
  });

  it('outputs JSON error on API failure in json mode', async () => {
    mockPull.mockRejectedValue(new Error('not found'));

    await expect(
      handleDatasetsPull(undefined, { ...baseOpts, name: 'test', json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('not found');
  });
});

describe('handleDatasetsCreate', () => {
  it('exits with error when no data to push', async () => {
    mockedLoadFromPaths.mockResolvedValue([]);

    await expect(
      handleDatasetsCreate('my-ds', ['./data'], { ...baseOpts, outputFile: '/tmp/out.json' }),
    ).rejects.toThrow('process.exit(1)');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('pushes, pulls, writes file, and outputs JSON in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });
    const items = [{ data: { x: 1 }, id: 'dp-1' }];
    mockPull.mockResolvedValue({ items, totalCount: 1 });

    await handleDatasetsCreate('my-ds', ['./data'], {
      ...baseOpts,
      outputFile: '/tmp/out.json',
      json: true,
    });

    expect(mockPush).toHaveBeenCalled();
    expect(mockedWriteToFile).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.name).toBe('my-ds');
    expect(output.path).toBe('/tmp/out.json');
    expect(output.count).toBe(1);
  });

  it('outputs JSON error when push fails in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockRejectedValue(new Error('push failed'));

    await expect(
      handleDatasetsCreate('my-ds', ['./data'], {
        ...baseOpts,
        outputFile: '/tmp/out.json',
        json: true,
      }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('push failed');
  });

  it('outputs JSON error when pull fails in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }] as any);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });
    mockPull.mockRejectedValue(new Error('pull failed'));

    await expect(
      handleDatasetsCreate('my-ds', ['./data'], {
        ...baseOpts,
        outputFile: '/tmp/out.json',
        json: true,
      }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('pull failed');
  });
});
