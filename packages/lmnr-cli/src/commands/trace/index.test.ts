import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The trace handler is now pure: the wrapper resolves a user-token client and
// owns the error envelope. We pass a stub client with the surfaces it uses.
const mockQuery = vi.fn();
const mockPushMetadata = vi.fn();

const stubClient = {
  sql: { query: mockQuery },
  traces: { pushMetadata: mockPushMetadata },
} as unknown as LaminarClient;

import { handleTraceAppendNote } from './index';

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };
const TRACE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const NOTE_KEY = 'rollout.note';

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleTraceAppendNote', () => {
  it('sets the note as-is when the trace has no existing note', async () => {
    mockQuery.mockResolvedValue([{ metadata: JSON.stringify({}) }]);

    await handleTraceAppendNote(stubClient, 'first note', TRACE_ID, baseOpts);

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

    await handleTraceAppendNote(stubClient, 'second note', TRACE_ID, baseOpts);

    expect(mockPushMetadata).toHaveBeenCalledWith(
      TRACE_ID,
      { [NOTE_KEY]: 'first note\n\nsecond note' },
      { failOnNotFound: true },
    );
  });

  it('normalizes a 32-char OTel hex trace id', async () => {
    mockQuery.mockResolvedValue([{ metadata: '{}' }]);

    await handleTraceAppendNote(stubClient, 'note', '0123456789abcdef0123456789abcdef', baseOpts);

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

    await handleTraceAppendNote(stubClient, 'b', TRACE_ID, { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ traceId: TRACE_ID, note: 'a\n\nb' }),
    );
  });

  it('throws to the wrapper when the trace does not exist', async () => {
    mockQuery.mockResolvedValue([]);

    await expect(handleTraceAppendNote(stubClient, 'note', TRACE_ID, baseOpts))
      .rejects.toThrow('not found');
    expect(mockPushMetadata).not.toHaveBeenCalled();
  });

  it('throws on an invalid trace id without querying', async () => {
    await expect(handleTraceAppendNote(stubClient, 'note', 'garbage', baseOpts))
      .rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockPushMetadata).not.toHaveBeenCalled();
  });

  it('falls back to the debug-session.json trace_id when no trace id is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lmnr-cli-test-'));
    mkdirSync(join(dir, '.lmnr'), { recursive: true });
    writeFileSync(
      join(dir, '.lmnr', 'debug-session.json'),
      JSON.stringify({ session_id: 'sess', trace_id: TRACE_ID }),
      'utf-8',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockQuery.mockResolvedValue([{ metadata: '{}' }]);

    await handleTraceAppendNote(stubClient, 'note', undefined, baseOpts);

    expect(mockPushMetadata).toHaveBeenCalledWith(
      TRACE_ID,
      { [NOTE_KEY]: 'note' },
      { failOnNotFound: true },
    );
  });

  it('throws an actionable error when no trace id is given and no file exists', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'lmnr-cli-test-')));

    await expect(handleTraceAppendNote(stubClient, 'note', undefined, baseOpts))
      .rejects.toThrow('No trace id given');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
