import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { LaminarLanguageModelV3 } from '../../src/opentelemetry-lib/instrumentation/aisdk/v3';
import { LaminarLanguageModelV2 } from '../../src/opentelemetry-lib/instrumentation/aisdk/v2';

void describe('Stream Caching', () => {
  void it('creates stream from cached text content (V3)', async () => {
    const content = [
      { type: 'text' as const, text: 'Hello world' }
    ];
    const finishReason = 'stop' as const;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };

    // Create mock model to access protected method
    const mockModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);

    // Access the protected method through type assertion
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    // Consume stream
    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify stream parts
    assert.ok(parts.length > 0);
    assert.strictEqual(parts[0].type, 'stream-start');
    assert.ok(parts.some(p => p.type === 'text-start'));
    assert.ok(parts.some(p => p.type === 'text-delta' && p.delta === 'Hello world'));
    assert.ok(parts.some(p => p.type === 'text-end'));
    assert.strictEqual(parts[parts.length - 1].type, 'finish');
  });

  void it('creates stream from cached tool call content (V3)', async () => {
    const content = [
      {
        type: 'tool-call' as const,
        toolCallId: 'call-123',
        toolName: 'get_weather',
        input: '{"location":"SF"}'
      }
    ];
    const finishReason = 'tool-calls' as const;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };

    const mockModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify tool-related stream parts
    assert.ok(parts.some(p => p.type === 'tool-input-start'));
    assert.ok(parts.some(p => p.type === 'tool-input-delta'));
    assert.ok(parts.some(p => p.type === 'tool-input-end'));
    assert.ok(parts.some(p => p.type === 'tool-call' && p.toolName === 'get_weather'));
  });

  void it('creates stream from cached reasoning content (V3)', async () => {
    const content = [
      { type: 'reasoning' as const, text: 'Let me think...' }
    ];
    const finishReason = 'stop' as const;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };

    const mockModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify reasoning stream parts
    assert.ok(parts.some(p => p.type === 'reasoning-start'));
    assert.ok(parts.some(p => p.type === 'reasoning-delta' && p.delta === 'Let me think...'));
    assert.ok(parts.some(p => p.type === 'reasoning-end'));
  });

  void it('creates stream with multiple content blocks (V3)', async () => {
    const content = [
      { type: 'text' as const, text: 'First' },
      { type: 'text' as const, text: 'Second' },
      { type: 'text' as const, text: 'Third' }
    ];
    const finishReason = 'stop' as const;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };

    const mockModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Should have 3 text blocks
    const textDeltas = parts.filter(p => p.type === 'text-delta');
    assert.strictEqual(textDeltas.length, 3);
    assert.strictEqual(textDeltas[0].delta, 'First');
    assert.strictEqual(textDeltas[1].delta, 'Second');
    assert.strictEqual(textDeltas[2].delta, 'Third');
  });

  void it('creates stream from cached text content (V2)', async () => {
    const content = [
      { type: 'text' as const, text: 'V2 response' }
    ];
    const finishReason = 'stop' as const;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const mockModel = {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV2(mockModel as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify stream structure
    assert.strictEqual(parts[0].type, 'stream-start');
    assert.ok(parts.some(p => p.type === 'text-delta' && p.delta === 'V2 response'));
    assert.strictEqual(parts[parts.length - 1].type, 'finish');
  });

  void it('creates stream with correct part order', async () => {
    const content = [
      { type: 'text' as const, text: 'Hello' }
    ];
    const finishReason = 'stop' as const;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };

    const mockModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream() }),
    };

    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(content, finishReason, usage);

    const parts: any[] = [];
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify order: stream-start -> text-start -> text-delta -> text-end -> finish
    assert.strictEqual(parts[0].type, 'stream-start');
    assert.strictEqual(parts[1].type, 'text-start');
    assert.strictEqual(parts[2].type, 'text-delta');
    assert.strictEqual(parts[3].type, 'text-end');
    assert.strictEqual(parts[4].type, 'finish');
  });
});

