import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { LaminarLanguageModelV2 } from '../src/opentelemetry-lib/instrumentation/aisdk/v2';
import { LaminarLanguageModelV3 } from '../src/opentelemetry-lib/instrumentation/aisdk/v3';

// Factory function to create V3 usage object
function createV3Usage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

// Factory function to create V2 usage object
function createV2Usage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

// Factory function to create a minimal V3 mock model
function createMockModelV3() {
  return {
    specificationVersion: 'v3' as const,
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: async () => ({
      content: [],
      finishReason: 'stop',
      usage: createV3Usage(),
      warnings: [],
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: async () => ({ stream: new ReadableStream() }),
  };
}

// Factory function to create a minimal V2 mock model
function createMockModelV2() {
  return {
    specificationVersion: 'v2' as const,
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: async () => ({
      content: [],
      finishReason: 'stop',
      usage: createV2Usage(),
      warnings: [],
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: async () => ({ stream: new ReadableStream() }),
  };
}

// Helper to consume a stream and return all parts
async function consumeStream(stream: ReadableStream): Promise<any[]> {
  const parts: any[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }

  return parts;
}

void describe('Stream Caching', () => {
  void it('creates stream from cached text content (V3)', async () => {
    const content = [
      { type: 'text' as const, text: 'Hello world' },
    ];
    const finishReason = 'stop' as const;
    const usage = createV3Usage();

    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      finishReason,
      usage,
    );
    const parts = await consumeStream(stream);

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
        input: '{"location":"SF"}',
      },
    ];
    const finishReason = 'tool-calls' as const;
    const usage = createV3Usage();

    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      finishReason,
      usage,
    );
    const parts = await consumeStream(stream);

    // Verify tool-related stream parts
    assert.ok(parts.some(p => p.type === 'tool-input-start'));
    assert.ok(parts.some(p => p.type === 'tool-input-delta'));
    assert.ok(parts.some(p => p.type === 'tool-input-end'));
    assert.ok(parts.some(p => p.type === 'tool-call' && p.toolName === 'get_weather'));
  });

  void it('creates stream from cached reasoning content (V3)', async () => {
    const content = [
      { type: 'reasoning' as const, text: 'Let me think...' },
    ];
    const finishReason = 'stop' as const;
    const usage = createV3Usage();

    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      finishReason,
      usage,
    );
    const parts = await consumeStream(stream);

    // Verify reasoning stream parts
    assert.ok(parts.some(p => p.type === 'reasoning-start'));
    assert.ok(parts.some(p => p.type === 'reasoning-delta' && p.delta === 'Let me think...'));
    assert.ok(parts.some(p => p.type === 'reasoning-end'));
  });

  void it('creates stream with multiple content blocks (V3)', async () => {
    const content = [
      { type: 'text' as const, text: 'First' },
      { type: 'text' as const, text: 'Second' },
      { type: 'text' as const, text: 'Third' },
    ];
    const finishReason = 'stop' as const;
    const usage = createV3Usage();

    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      finishReason,
      usage,
    );
    const parts = await consumeStream(stream);

    // Should have 3 text blocks
    const textDeltas = parts.filter(p => p.type === 'text-delta');
    assert.strictEqual(textDeltas.length, 3);
    assert.strictEqual(textDeltas[0].delta, 'First');
    assert.strictEqual(textDeltas[1].delta, 'Second');
    assert.strictEqual(textDeltas[2].delta, 'Third');
  });

  void it('creates stream from cached text content (V2)', async () => {
    const content = [
      { type: 'text' as const, text: 'V2 response' },
    ];
    const finishReason = 'stop' as const;
    const usage = createV2Usage();

    const wrappedModel = new LaminarLanguageModelV2(createMockModelV2() as any);
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      finishReason,
      usage,
    );
    const parts = await consumeStream(stream);

    // Verify stream structure
    assert.strictEqual(parts[0].type, 'stream-start');
    assert.ok(parts.some(p => p.type === 'text-delta' && p.delta === 'V2 response'));
    assert.strictEqual(parts[parts.length - 1].type, 'finish');
  });

  void it('returns empty content for a null cached output (no crash)', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    // A no-payload HIT serializes to the string "null" in `output`; parsing it
    // yields `null`, which must not crash reconstruction.
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output: 'null',
      attributes: {},
    });
    assert.deepStrictEqual(parsed.content, []);
  });

  void it('returns empty content for a primitive cached output (no crash)', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output: '42',
      attributes: {},
    });
    assert.deepStrictEqual(parsed.content, []);
  });

  void it('rebuilds content from verbatim v7 gen_ai.output.messages (LAM-1922)', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    // The v7 integration now stores the assistant turn VERBATIM as
    // `[{role:"assistant", content: LanguageModelContent[]}]` — parts keep the
    // provider field names (`text`, `toolCallId`, `toolName`, `input`) and
    // tool-call `input` is already a JSON string. Rebuild must not rename keys
    // or double-stringify the input.
    const output = JSON.stringify([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Let me think...' },
          { type: 'text', text: 'Hello world' },
          {
            type: 'tool-call',
            toolCallId: 'call-123',
            toolName: 'get_weather',
            input: '{"location":"SF"}',
          },
        ],
      },
    ]);
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output,
      attributes: { 'ai.response.finishReason': 'tool-calls' },
    });
    assert.deepStrictEqual(parsed.content, [
      { type: 'reasoning', text: 'Let me think...' },
      { type: 'text', text: 'Hello world' },
      {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'get_weather',
        input: '{"location":"SF"}',
      },
    ]);
    assert.strictEqual(parsed.finishReason, 'tool-calls');
  });

  void it('preserves provider fields on verbatim v7 parts (LAM-1922)', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    // Provider fields (`providerMetadata`, `providerExecuted`) must survive
    // the rebuild verbatim: the AI SDK echoes them into the next step's
    // prompt as `providerOptions`, and the replay cache hashes that prompt —
    // dropping them causes a spurious MISS on the following step.
    const output = JSON.stringify([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Checking the weather.',
            providerMetadata: { anthropic: { signature: 'sig-1' } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-123',
            toolName: 'get_weather',
            input: '{"location":"SF"}',
            providerExecuted: false,
            providerMetadata: { anthropic: { caller: { type: 'direct' } } },
          },
        ],
      },
    ]);
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output,
      attributes: { 'ai.response.finishReason': 'tool-calls' },
    });
    assert.deepStrictEqual(parsed.content, [
      {
        type: 'text',
        text: 'Checking the weather.',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'get_weather',
        input: '{"location":"SF"}',
        providerExecuted: false,
        providerMetadata: { anthropic: { caller: { type: 'direct' } } },
      },
    ]);
  });

  void it('threads provider fields onto rebuilt stream parts (LAM-1922)', async () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const content = [
      {
        type: 'text' as const,
        text: 'Hello',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call' as const,
        toolCallId: 'call-123',
        toolName: 'get_weather',
        input: '{"location":"SF"}',
        providerExecuted: false,
        providerMetadata: { anthropic: { caller: { type: 'direct' } } },
      },
    ];
    const stream = (wrappedModel as any).createStreamFromCachedResponse(
      content,
      'tool-calls',
      createV3Usage(),
    );
    const parts = await consumeStream(stream);

    const textStart = parts.find(p => p.type === 'text-start');
    assert.deepStrictEqual(
      textStart.providerMetadata,
      { anthropic: { signature: 'sig-1' } },
    );
    const toolCall = parts.find(p => p.type === 'tool-call');
    assert.deepStrictEqual(toolCall, {
      type: 'tool-call',
      toolCallId: 'call-123',
      toolName: 'get_weather',
      input: '{"location":"SF"}',
      providerExecuted: false,
      providerMetadata: { anthropic: { caller: { type: 'direct' } } },
    });
  });

  void it('rebuilds content from v7 gen_ai.output.messages parts', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    // v7 stores the assistant turn verbatim as `[{role, parts:[...]}]` where
    // each part uses `{type, content}` (text/thinking) or
    // `{type:"tool_call", id, name, arguments}`.
    const output = JSON.stringify([
      {
        role: 'assistant',
        parts: [
          { type: 'thinking', content: 'Let me think...' },
          { type: 'text', content: 'Hello world' },
          {
            type: 'tool_call',
            id: 'call-123',
            name: 'get_weather',
            arguments: { location: 'SF' },
          },
        ],
      },
    ]);
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output,
      attributes: { 'ai.response.finishReason': 'tool-calls' },
    });
    assert.deepStrictEqual(parsed.content, [
      { type: 'reasoning', text: 'Let me think...' },
      { type: 'text', text: 'Hello world' },
      {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'get_weather',
        input: '{"location":"SF"}',
      },
    ]);
    assert.strictEqual(parsed.finishReason, 'tool-calls');
  });

  void it('rebuilds content from v6 legacy message content shape', () => {
    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    // v6 legacy stores `[{role, content:[{type:"text", text}, ...]}]`.
    const output = JSON.stringify([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi there' },
          {
            type: 'tool_call',
            name: 'lookup',
            id: 'tc-1',
            arguments: { q: 'a' },
          },
        ],
      },
    ]);
    const parsed = (wrappedModel as any).parseCachedSpan({
      name: '',
      input: '',
      output,
      attributes: {},
    });
    assert.deepStrictEqual(parsed.content, [
      { type: 'text', text: 'Hi there' },
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'lookup',
        input: '{"q":"a"}',
      },
    ]);
    assert.strictEqual(parsed.finishReason, 'stop');
  });

  void it('creates stream with correct part order', async () => {
    const content = [
      { type: 'text' as const, text: 'Hello' },
    ];
    const finishReason = 'stop' as const;
    const usage = createV3Usage();

    const wrappedModel = new LaminarLanguageModelV3(createMockModelV3() as any);
    const stream =
      (wrappedModel as any).createStreamFromCachedResponse(
        content,
        finishReason,
        usage,
      );
    const parts = await consumeStream(stream);

    // Verify order: stream-start -> text-start -> text-delta -> text-end -> finish
    assert.strictEqual(parts[0].type, 'stream-start');
    assert.strictEqual(parts[1].type, 'text-start');
    assert.strictEqual(parts[2].type, 'text-delta');
    assert.strictEqual(parts[3].type, 'text-end');
    assert.strictEqual(parts[4].type, 'finish');
  });
});

