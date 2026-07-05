import type { LaminarClient } from '@lmnr-ai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The debug handlers are now pure: the wrapper resolves a user-token client and
// owns the error envelope. We pass a stub client with the surfaces it uses.
const mockListBlocks = vi.fn();
const mockAddBlock = vi.fn();
const mockSetName = vi.fn();

const stubClient = {
  rolloutSessions: {
    setName: mockSetName,
    listBlocks: mockListBlocks,
    addBlock: mockAddBlock,
  },
} as unknown as LaminarClient;

import { handleDebugSessionAddNote, handleDebugSessionSummary } from './index';

const baseOpts = { projectId: 'fake-project', baseUrl: 'http://localhost', port: 8080 };
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const traceBlock = (id: string, traceId: string, createdAt: string) => ({
  id,
  createdAt,
  type: 'trace',
  content: { traceId },
});

const textBlock = (id: string, text: string, createdAt: string) => ({
  id,
  createdAt,
  type: 'text',
  content: { text },
});

const evalBlock = (id: string, evaluationId: string, createdAt: string) => ({
  id,
  createdAt,
  type: 'evaluation',
  content: { evaluationId },
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
  it('renders trace / text / eval blocks oldest-first in text mode', async () => {
    mockListBlocks.mockResolvedValue([
      textBlock('b2', 'a finding', '2026-06-01T10:30:00.000Z'),
      traceBlock('b1', 'trace-1', '2026-06-01T10:00:00.000Z'),
      evalBlock('b3', 'eval-9', '2026-06-01T11:00:00.000Z'),
    ]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith(
      '<trace id="trace-1"/>\n\na finding\n\n<evaluation id="eval-9"/>',
    );
  });

  it('skips blocks with missing ids / empty text', async () => {
    mockListBlocks.mockResolvedValue([
      traceBlock('b1', 'trace-1', '2026-06-01T10:00:00.000Z'),
      { id: 'b2', createdAt: '2026-06-01T10:30:00.000Z', type: 'text', content: { text: '' } },
    ]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith('<trace id="trace-1"/>');
  });

  it('outputs the ordered blocks array in json mode', async () => {
    const blocks = [
      textBlock('b2', 'note', '2026-06-01T11:00:00.000Z'),
      traceBlock('b1', 'trace-1', '2026-06-01T10:00:00.000Z'),
    ];
    mockListBlocks.mockResolvedValue(blocks);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([
      traceBlock('b1', 'trace-1', '2026-06-01T10:00:00.000Z'),
      textBlock('b2', 'note', '2026-06-01T11:00:00.000Z'),
    ]));
  });

  it('passes the session id to listBlocks', async () => {
    mockListBlocks.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(mockListBlocks).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it('prints a friendly message for an empty session in text mode', async () => {
    mockListBlocks.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID });

    expect(logSpy).toHaveBeenCalledWith(`No blocks found for session ${SESSION_ID}.`);
  });

  it('outputs [] for an empty session in json mode', async () => {
    mockListBlocks.mockResolvedValue([]);

    await handleDebugSessionSummary(stubClient, { ...baseOpts, sessionId: SESSION_ID, json: true });

    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('propagates listBlocks failures to the wrapper', async () => {
    mockListBlocks.mockRejectedValue(new Error('boom'));

    const opts = { ...baseOpts, sessionId: SESSION_ID, json: true };
    await expect(handleDebugSessionSummary(stubClient, opts)).rejects.toThrow('boom');
  });
});

describe('handleDebugSessionAddNote', () => {
  it('adds a text block to the session', async () => {
    mockAddBlock.mockResolvedValue('block-1');

    await handleDebugSessionAddNote(
      stubClient,
      'a finding',
      { ...baseOpts, sessionId: SESSION_ID },
    );

    expect(mockAddBlock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      type: 'text',
      content: { text: 'a finding' },
      failOnNotFound: true,
    });
  });

  it('outputs {sessionId, blockId, note} in json mode', async () => {
    mockAddBlock.mockResolvedValue('block-1');

    await handleDebugSessionAddNote(
      stubClient,
      'a finding',
      { ...baseOpts, sessionId: SESSION_ID, json: true },
    );

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ sessionId: SESSION_ID, blockId: 'block-1', note: 'a finding' }),
    );
  });

  it('propagates addBlock failures to the wrapper', async () => {
    mockAddBlock.mockRejectedValue(new Error('404 not found'));

    await expect(
      handleDebugSessionAddNote(stubClient, 'x', { ...baseOpts, sessionId: SESSION_ID }),
    ).rejects.toThrow('not found');
  });
});
