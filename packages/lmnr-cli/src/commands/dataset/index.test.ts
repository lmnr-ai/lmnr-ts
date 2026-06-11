import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The dataset handlers are now pure: the wrapper resolves the client and owns
// the error envelope. We pass a stub client with the datasets surface directly.
const mockListDatasets = vi.fn();
const mockPush = vi.fn();
const mockPull = vi.fn();

const stubClient = {
  datasets: {
    listDatasets: mockListDatasets,
    push: mockPush,
    pull: mockPull,
  },
} as unknown as LaminarClient;

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
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };

describe('handleDatasetsList', () => {
  it('outputs JSON array in json mode', async () => {
    const datasets = [{ id: 'abc-123', name: 'test-ds', createdAt: '2024-01-01T00:00:00Z' }];
    mockListDatasets.mockResolvedValue(datasets);

    await handleDatasetsList(stubClient, { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(datasets));
  });

  it('outputs empty JSON array in json mode when no datasets', async () => {
    mockListDatasets.mockResolvedValue([]);

    await handleDatasetsList(stubClient, { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('prints table in human mode', async () => {
    const datasets = [{ id: 'abc-123', name: 'test-ds', createdAt: '2024-01-01T00:00:00Z' }];
    mockListDatasets.mockResolvedValue(datasets);

    await handleDatasetsList(stubClient, baseOpts);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('ID');
    expect(output).toContain('test-ds');
    expect(output).toContain('Total: 1 dataset(s)');
  });

  it('prints "No datasets found." in human mode when empty', async () => {
    mockListDatasets.mockResolvedValue([]);

    await handleDatasetsList(stubClient, baseOpts);

    expect(logSpy).toHaveBeenCalledWith('No datasets found.');
  });

  it('propagates API failures to the wrapper', async () => {
    mockListDatasets.mockRejectedValue(new Error('unauthorized'));

    await expect(handleDatasetsList(stubClient, baseOpts)).rejects.toThrow('unauthorized');
  });
});

describe('handleDatasetsPush', () => {
  it('throws when neither name nor id provided', async () => {
    await expect(handleDatasetsPush(stubClient, [], { ...baseOpts })).rejects.toThrow(
      'name or id',
    );
  });

  it('throws when both name and id provided', async () => {
    await expect(
      handleDatasetsPush(stubClient, [], { ...baseOpts, name: 'x', id: 'y' as any }),
    ).rejects.toThrow('Only one of name or id');
  });

  it('throws when no data to push', async () => {
    mockedLoadFromPaths.mockResolvedValue([]);

    await expect(
      handleDatasetsPush(stubClient, ['./data'], { ...baseOpts, name: 'test' }),
    ).rejects.toThrow('No data to push');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('outputs JSON on success in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });

    await handleDatasetsPush(stubClient, ['./data'], { ...baseOpts, name: 'test', json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.datasetId).toBe('ds-123');
    expect(output.count).toBe(1);
  });

  it('pushes data in human mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });

    await handleDatasetsPush(stubClient, ['./data'], { ...baseOpts, name: 'test' });

    expect(mockPush).toHaveBeenCalled();
  });

  it('propagates API failures to the wrapper', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockRejectedValue(new Error('server error'));

    await expect(
      handleDatasetsPush(stubClient, ['./data'], { ...baseOpts, name: 'test' }),
    ).rejects.toThrow('server error');
  });
});

describe('handleDatasetsPull', () => {
  it('throws when neither name nor id provided', async () => {
    await expect(handleDatasetsPull(stubClient, undefined, { ...baseOpts })).rejects.toThrow(
      'name or id',
    );
  });

  it('throws when both name and id provided', async () => {
    await expect(
      handleDatasetsPull(stubClient, undefined, { ...baseOpts, name: 'x', id: 'y' as any }),
    ).rejects.toThrow('Only one of name or id');
  });

  it('writes to file and outputs JSON confirmation in json mode', async () => {
    mockPull.mockResolvedValue({ items: [{ data: { a: 1 } }], totalCount: 1 });

    await handleDatasetsPull(stubClient, '/tmp/out.json', {
      ...baseOpts,
      name: 'test',
      json: true,
    });

    expect(mockedWriteToFile).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.path).toBe('/tmp/out.json');
    expect(output.count).toBe(1);
  });

  it('writes to file in human mode', async () => {
    mockPull.mockResolvedValue({ items: [{ data: { a: 1 } }], totalCount: 1 });

    await handleDatasetsPull(stubClient, '/tmp/out.json', { ...baseOpts, name: 'test' });

    expect(mockedWriteToFile).toHaveBeenCalled();
  });

  it('outputs data to stdout in json mode without output path', async () => {
    const items = [{ data: { a: 1 } }, { data: { a: 2 } }];
    mockPull.mockResolvedValue({ items, totalCount: 2 });

    await handleDatasetsPull(stubClient, undefined, { ...baseOpts, name: 'test', json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toEqual(items);
  });

  it('calls printToConsole in human mode without output path', async () => {
    const items = [{ data: { a: 1 } }];
    mockPull.mockResolvedValue({ items, totalCount: 1 });

    await handleDatasetsPull(stubClient, undefined, {
      ...baseOpts,
      name: 'test',
      outputFormat: 'jsonl',
    });

    expect(mockedPrintToConsole).toHaveBeenCalledWith(items, 'jsonl');
  });

  it('propagates API failures to the wrapper', async () => {
    mockPull.mockRejectedValue(new Error('not found'));

    await expect(
      handleDatasetsPull(stubClient, undefined, { ...baseOpts, name: 'test' }),
    ).rejects.toThrow('not found');
  });
});

describe('handleDatasetsCreate', () => {
  it('throws when no data to push', async () => {
    mockedLoadFromPaths.mockResolvedValue([]);

    await expect(
      handleDatasetsCreate(stubClient, 'my-ds', ['./data'], {
        ...baseOpts,
        outputFile: '/tmp/out.json',
      }),
    ).rejects.toThrow('No data to push');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('pushes, pulls, writes file, and outputs JSON in json mode', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });
    const items = [{ data: { x: 1 }, id: 'dp-1' }];
    mockPull.mockResolvedValue({ items, totalCount: 1 });

    await handleDatasetsCreate(stubClient, 'my-ds', ['./data'], {
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

  it('propagates push failures to the wrapper', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockRejectedValue(new Error('push failed'));

    await expect(
      handleDatasetsCreate(stubClient, 'my-ds', ['./data'], {
        ...baseOpts,
        outputFile: '/tmp/out.json',
      }),
    ).rejects.toThrow('push failed');
  });

  it('propagates pull failures to the wrapper', async () => {
    mockedLoadFromPaths.mockResolvedValue([{ data: { x: 1 } }]);
    mockPush.mockResolvedValue({ datasetId: 'ds-123' });
    mockPull.mockRejectedValue(new Error('pull failed'));

    await expect(
      handleDatasetsCreate(stubClient, 'my-ds', ['./data'], {
        ...baseOpts,
        outputFile: '/tmp/out.json',
      }),
    ).rejects.toThrow('pull failed');
  });
});
