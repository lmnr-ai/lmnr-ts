import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockSetName = vi.fn();

vi.mock('@lmnr-ai/client', () => ({
  LaminarClient: class {
    sql = { query: mockQuery };
    rolloutSessions = { setName: mockSetName };
  },
}));

import { handleDebugSessionSummary } from './index';

const baseOpts = { projectApiKey: 'fake-key', baseUrl: 'http://localhost', port: 8080 };
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
  vi.spyOn(process, 'exit').mockImplementation((code?) => {
    throw new Error(`process.exit(${code})`);
  });
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

    await handleDebugSessionSummary(SESSION_ID, baseOpts);

    expect(logSpy).toHaveBeenCalledWith(
      'first run note\n<trace id="trace-1" end-time="2026-06-01T10:00:00.000Z"/>' +
        '\n\n' +
        'second run note\n<trace id="trace-2" end-time="2026-06-01T11:00:00.000Z"/>',
    );
  });

  it('prints only the trace tag when a trace has no note', async () => {
    mockQuery.mockResolvedValue([traceRow('trace-1', '2026-06-01T10:00:00.000Z')]);

    await handleDebugSessionSummary(SESSION_ID, baseOpts);

    expect(logSpy).toHaveBeenCalledWith(
      '<trace id="trace-1" end-time="2026-06-01T10:00:00.000Z"/>',
    );
  });

  it('outputs an array of {note, traceId, endTime} in json mode', async () => {
    mockQuery.mockResolvedValue([
      traceRow('trace-1', '2026-06-01T10:00:00.000Z', 'a note'),
      traceRow('trace-2', '2026-06-01T11:00:00.000Z'),
    ]);

    await handleDebugSessionSummary(SESSION_ID, { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([
      { note: 'a note', traceId: 'trace-1', endTime: '2026-06-01T10:00:00.000Z' },
      { note: '', traceId: 'trace-2', endTime: '2026-06-01T11:00:00.000Z' },
    ]));
  });

  it('filters by session id and orders chronologically', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(SESSION_ID, { ...baseOpts, json: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("simpleJSONExtractString(metadata, 'rollout.session_id')");
    expect(sql).toContain('ORDER BY start_time');
    expect(sql).toContain('formatDateTime(end_time');
    expect(params).toMatchObject({ session_id: SESSION_ID });
  });

  it('pages through results larger than one page', async () => {
    const page = Array.from({ length: 1000 }, (_, i) =>
      traceRow(`trace-${i}`, '2026-06-01T10:00:00.000Z'),
    );
    mockQuery
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([traceRow('trace-last', '2026-06-01T11:00:00.000Z')]);

    await handleDebugSessionSummary(SESSION_ID, { ...baseOpts, json: true });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][1]).toMatchObject({ offset: 1000 });
    const output = JSON.parse(String(logSpy.mock.calls[0][0])) as unknown[];
    expect(output).toHaveLength(1001);
  });

  it('prints a friendly message for an empty session in text mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(SESSION_ID, baseOpts);

    expect(logSpy).toHaveBeenCalledWith(`No traces found for session ${SESSION_ID}.`);
  });

  it('outputs [] for an empty session in json mode', async () => {
    mockQuery.mockResolvedValue([]);

    await handleDebugSessionSummary(SESSION_ID, { ...baseOpts, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('exits 1 with a JSON error in json mode on query failure', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));

    await expect(handleDebugSessionSummary(SESSION_ID, { ...baseOpts, json: true }))
      .rejects.toThrow('process.exit(1)');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }));
  });
});
