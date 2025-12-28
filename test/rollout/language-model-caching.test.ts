import * as assert from 'node:assert';
import * as http from 'node:http';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { startCacheServer } from '../../src/cli/rollout/cache-server';
import { Laminar } from '../../src/laminar';
import { _resetConfiguration, initializeTracing } from '../../src/opentelemetry-lib/configuration';
import { LaminarLanguageModelV2 } from '../../src/opentelemetry-lib/instrumentation/aisdk/v2';
import { LaminarLanguageModelV3 } from '../../src/opentelemetry-lib/instrumentation/aisdk/v3';

// Helper to close server
async function closeServer(server: http.Server): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(() => server.closeAllConnections?.(), 10);
  });
}

// Factory function to create a V3 mock model
function createMockModelV3(responseText: string = 'Live response', modelId: string = 'test-model') {
  return {
    specificationVersion: 'v3' as const,
    provider: 'test',
    modelId,
    supportedUrls: {},
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: mock.fn(async () => ({
      content: [{ type: 'text', text: responseText }],
      finishReason: 'stop',
      usage: {
        inputTokens: {
          total: 0,
          noCache: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 0,
          text: 0,
          reasoning: 0,
        },
      },
      warnings: [],
    })),
    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: mock.fn(async () => ({ stream: new ReadableStream() })),
  };
}

// Factory function to create a V2 mock model
function createMockModelV2(
  responseText: string = 'Live V2 response', modelId: string = 'test-model',
) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'test',
    modelId,
    supportedUrls: {},
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: mock.fn(async () => ({
      content: [{ type: 'text', text: responseText }],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    })),
    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: async () => ({ stream: new ReadableStream() }),
  };
}

// Helper to execute code within a span context
async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const span = Laminar.startActiveSpan({ name });
  try {
    return await fn();
  } finally {
    span.end();
  }
}

void describe('LaminarLanguageModel Caching', () => {
  const exporter = new InMemorySpanExporter();
  let cacheServer: http.Server;
  let cacheServerPort: number;
  let cache: Map<string, any>;
  let setMetadata: (metadata: any) => void;

  void beforeEach(async () => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });

    // Start cache server
    const result = await startCacheServer();
    cacheServer = result.server;
    cacheServerPort = result.port;
    cache = result.cache;
    setMetadata = result.setMetadata;

    // Set env vars
    process.env.LMNR_ROLLOUT_SESSION_ID = 'test-session';
    process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS = `http://localhost:${cacheServerPort}`;
  });

  void afterEach(async () => {
    exporter.reset();
    delete process.env.LMNR_ROLLOUT_SESSION_ID;
    delete process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS;
    await closeServer(cacheServer);
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it('returns cached response on cache hit (V3)', async () => {
    // Set up cache using the shared cache from beforeEach
    // Path will be 'test' since we create a span with name 'test'
    cache.set('0:test', {
      name: 'test',
      input: '{}',
      output: JSON.stringify([{ type: 'text', text: 'Cached response' }]),
      attributes: { 'ai.response.finishReason': 'stop' },
    });

    setMetadata({
      pathToCount: { 'test': 1 },
    });

    const mockModel = createMockModelV3('Live response');
    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);

    await withSpan('test', async () => {
      const result = await wrappedModel.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      });

      // Should return cached response
      assert.strictEqual(result.content[0].type, 'text');
      assert.strictEqual((result.content[0] as any).text, 'Cached response');

      // Mock model should not be called
      assert.strictEqual(mockModel.doGenerate.mock.calls.length, 0);
    });
  });

  void it('falls back to original model on cache miss (V3)', async () => {
    setMetadata({
      pathToCount: { 'test': 1 },
    });

    const mockModel = createMockModelV3('Live response');
    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);

    await withSpan('test', async () => {
      const result = await wrappedModel.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      });

      // Should return live response
      assert.strictEqual(result.content[0].type, 'text');
      assert.strictEqual((result.content[0] as any).text, 'Live response');

      // Mock model should be called
      assert.strictEqual(mockModel.doGenerate.mock.calls.length, 1);
    });
  });

  void it('returns cached response on cache hit (V2)', async () => {
    // Set up cache using the shared cache from beforeEach
    cache.set('0:test', {
      name: 'test',
      input: '{}',
      output: JSON.stringify([{ type: 'text', text: 'Cached V2 response' }]),
      attributes: { 'ai.response.finishReason': 'stop' },
    });

    setMetadata({
      pathToCount: { 'test': 1 },
    });

    const mockModel = createMockModelV2();
    const wrappedModel = new LaminarLanguageModelV2(mockModel as any);

    await withSpan('test', async () => {
      const result = await wrappedModel.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      });

      // Should return cached response
      assert.strictEqual(result.content[0].type, 'text');
      assert.strictEqual((result.content[0] as any).text, 'Cached V2 response');

      // Mock model should not be called
      assert.strictEqual(mockModel.doGenerate.mock.calls.length, 0);
    });
  });

  void it('works without cache server env var', async () => {
    delete process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS;

    const mockModel = createMockModelV3('Live', 'test');
    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);

    const result = await wrappedModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    });

    // Should call live model
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual((result.content[0] as any).text, 'Live');
    assert.strictEqual(mockModel.doGenerate.mock.calls.length, 1);
  });

  void it('works without rollout session ID env var', async () => {
    delete process.env.LMNR_ROLLOUT_SESSION_ID;

    const mockModel = createMockModelV3('Live', 'test');
    const wrappedModel = new LaminarLanguageModelV3(mockModel as any);

    const result = await wrappedModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    });

    // Should call live model (no rollout session)
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual((result.content[0] as any).text, 'Live');
    assert.strictEqual(mockModel.doGenerate.mock.calls.length, 1);
  });
});

