import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockTag = vi.fn();

vi.mock('@lmnr-ai/client', () => ({
  LaminarClient: class {
    tags = {
      tag: mockTag,
    };
  },
}));

import { handleTraceTagAdd } from './index';

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

describe('handleTraceTagAdd', () => {
  it('outputs JSON on success in json mode', async () => {
    mockTag.mockResolvedValue({ ok: true });

    await handleTraceTagAdd('abc-123', ['tag1', 'tag2'], { ...baseOpts, json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.traceId).toBe('abc-123');
    expect(output.tags).toEqual(['tag1', 'tag2']);
  });

  it('calls client.tags.tag with correct args', async () => {
    mockTag.mockResolvedValue({ ok: true });

    await handleTraceTagAdd('abc-123', ['tag1'], baseOpts);

    expect(mockTag).toHaveBeenCalledWith('abc-123', ['tag1']);
  });

  it('outputs JSON error on API failure in json mode', async () => {
    mockTag.mockRejectedValue(new Error('unauthorized'));

    await expect(
      handleTraceTagAdd('abc-123', ['tag1'], { ...baseOpts, json: true }),
    ).rejects.toThrow('process.exit(1)');

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('unauthorized');
  });

  it('exits on API failure in human mode', async () => {
    mockTag.mockRejectedValue(new Error('not found'));

    await expect(
      handleTraceTagAdd('abc-123', ['tag1'], baseOpts),
    ).rejects.toThrow('process.exit(1)');
  });
});
