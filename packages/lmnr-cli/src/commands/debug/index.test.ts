import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The debug handlers are now pure: the wrapper resolves a user-token client and
// owns the error envelope. We pass a stub client with the surfaces it uses.
const mockQuery = vi.fn();
const mockSetName = vi.fn();

const stubClient = {
  sql: { query: mockQuery },
  rolloutSessions: { setName: mockSetName },
} as unknown as LaminarClient;

import { handleDebugSessionSummary } from './index';

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOTE_KEY = 'rollout.note';

const traceRow = (id: string, endTime: string, note?: string) => ({
  id,
  end_time: endTime,
  metadata: JSON.stringify({
    'rollout.session_id': SESSION_ID,
    ...(note === undefined ? {} : { [NOTE_KEY]: note }),
  }),
});

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDebugSessionSummary', () => {
  it('prints note + trace tag blocks in text mode', async () => {
    mockQuery.mockResolvedValue([
      traceRow('trace-1', '2026-06-01T10:00:00.000Z', 'first run note'),
      traceRow('trace-2', '2026-06-01T11:00:00.000Z', 'second run note'),
    ]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith(
      'first run note\n<trace id="trace-1" end-time="2026-06-01T10:00:00.000Z"/>' +
        '\n\n' +
        'second run note\n<trace id="trace-2" end-time="2026-06-01T11:00:00.000Z"/>',
    );
  });

  it('prints only the trace tag when a trace has no note', async () => {
    mockQuery.mockResolvedValue([traceRow('trace-1', '2026-06-01T10:00:00.000Z')]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith(
      '<trace id="trace-1" end-time="2026-06-01T10:00:00.000Z"/>',
    );
  });

  it('outputs an array of {note, traceId, endTime} in json mode', async () => {
    mockQuery.mockResolvedValue([
      traceRow('trace-1', '2026-06-01T10:00:00.000Z', 'a note'),
      traceRow('trace-2', '2026-06-01T11:00:00.000Z'),
    ]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([
      { note: 'a note', traceId: 'trace-1', endTime: '2026-06-01T10:00:00.000Z' },
      { note: '', traceId: 'trace-2', endTime: '2026-06-01T11:00:00.000Z' },
    ]));
  });

  it('filters by session id and orders chronologically', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("simpleJSONExtractString(metadata, 'rollout.session_id')");
    expect(sql).toContain('ORDER BY start_time');
    expect(sql).toContain('formatDateTime(end_time');
    expect(params).toMatchObject({ session_id: SESSION_ID });
  });

  it('fetches all rows in a single un-paged query', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      traceRow(`trace-${i}`, '2026-06-01T10:00:00.000Z'),
    );
    mockQuery.mockResolvedValue(rows);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('OFFSET');
    expect(params).toEqual({ session_id: SESSION_ID });
    const output = JSON.parse(String(logSpy.mock.calls[0][0])) as unknown[];
    expect(output).toHaveLength(1500);
  });

  it('prints a friendly message for an empty session in text mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith(`No traces found for session ${SESSION_ID}.`);
  });

  it('outputs [] for an empty session in json mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('propagates query failures to the wrapper', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));

    const opts = { ...baseOpts, sessionId: SESSION_ID, json: true };
    await expect(handleDebugSessionSummary(stubClient, opts)).rejects.toThrow('boom');
  });
});
