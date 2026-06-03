import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockPushMetadata = vi.fn();

vi.mock('@lmnr-ai/client', () => ({
  LaminarClient: class {
    sql = { query: mockQuery };
    traces = { pushMetadata: mockPushMetadata };
  },
}));

import { handleTraceAppendNote } from './index';

const baseOpts = { projectApiKey: 'fake-key', baseUrl: 'http://localhost', port: 8080 };
const TRACE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const NOTE_KEY = 'rollout.note';

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

describe('handleTraceAppendNote', () => {
  it('sets the note as-is when the trace has no existing note', async () => {
    mockQuery.mockResolvedValue([{ metadata: JSON.stringify({}) }]);

    await handleTraceAppendNote(TRACE_ID, 'first note', baseOpts);

    expect(mockPushMetadata).toHaveBeenCalledWith(
      TRACE_ID,
      { [NOTE_KEY]: 'first note' },
      { failOnNotFound: true },
    );
  });

  it('appends to an existing note with a blank-line separator', async () => {
    mockQuery.mockResolvedValue([
      { metadata: JSON.stringify({ [NOTE_KEY]: 'first note' }) },
    ]);

    await handleTraceAppendNote(TRACE_ID, 'second note', baseOpts);

    expect(mockPushMetadata).toHaveBeenCalledWith(
      TRACE_ID,
      { [NOTE_KEY]: 'first note\n\nsecond note' },
      { failOnNotFound: true },
    );
  });

  it('normalizes a 32-char OTel hex trace id', async () => {
    mockQuery.mockResolvedValue([{ metadata: '{}' }]);

    await handleTraceAppendNote('0123456789abcdef0123456789abcdef', 'note', baseOpts);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT metadata FROM traces'),
      { trace_id: TRACE_ID },
    );
    expect(mockPushMetadata).toHaveBeenCalledWith(
      TRACE_ID,
      { [NOTE_KEY]: 'note' },
      { failOnNotFound: true },
    );
  });

  it('outputs the full updated note in json mode', async () => {
    mockQuery.mockResolvedValue([
      { metadata: JSON.stringify({ [NOTE_KEY]: 'a' }) },
    ]);

    await handleTraceAppendNote(TRACE_ID, 'b', { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ traceId: TRACE_ID, note: 'a\n\nb' }),
    );
  });

  it('errors when the trace does not exist', async () => {
    mockQuery.mockResolvedValue([]);

    await expect(handleTraceAppendNote(TRACE_ID, 'note', baseOpts))
      .rejects.toThrow('process.exit(1)');
    expect(mockPushMetadata).not.toHaveBeenCalled();
  });

  it('errors on an invalid trace id without querying', async () => {
    await expect(handleTraceAppendNote('garbage', 'note', baseOpts))
      .rejects.toThrow('process.exit(1)');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockPushMetadata).not.toHaveBeenCalled();
  });
});
