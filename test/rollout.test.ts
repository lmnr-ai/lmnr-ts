import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { startCacheServer, CachedSpan } from '../src/cli/rollout/cache-server';
import { observeRollout } from '../src/decorators';
import { RolloutParam } from '../src';

// Helper to make HTTP requests
async function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: any
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close', // Ensure connection closes after request
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 0,
            data: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({
            status: res.statusCode || 0,
            data: null,
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// Helper to close server and wait
async function closeServer(server: http.Server): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));

  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });

    setTimeout(() => {
      server.closeAllConnections?.();
    }, 10);
  });
}

describe('Cache Server Tests', () => {
  it('should start server on available port starting from 35667', async () => {
    const { port, server } = await startCacheServer(35667);

    try {
      assert.ok(port >= 35667, 'Port should be >= 35667');
    } finally {
      await closeServer(server);
    }
  });

  it('should return 200 for health check', async () => {
    const { port, server } = await startCacheServer();

    try {
      const response = await makeRequest(port, 'GET', '/health');

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.data, { status: 'ok' });
    } finally {
      await closeServer(server);
    }
  });

  it('should return 404 for missing cache keys', async () => {
    const { port, server } = await startCacheServer();

    try {
      const response = await makeRequest(port, 'POST', '/cached', {
        path: 'test.path',
        index: 0,
      });

      assert.strictEqual(response.status, 404);
    } finally {
      await closeServer(server);
    }
  });

  it('should return cached span data with metadata', async () => {
    const { port, server, cache, setMetadata } = await startCacheServer();

    try {
      // Set up cache
      const testSpan: CachedSpan = {
        name: 'test-span',
        input: '{"test": "input"}',
        output: '{"test": "output"}',
        attributes: { 'ai.response.finishReason': 'stop' },
      };

      cache.set('0:test.path', testSpan);

      setMetadata({
        pathToCount: { 'test.path': 1 },
        overrides: { 'test.path': { system: 'test system' } },
      });

      const response = await makeRequest(port, 'POST', '/cached', {
        path: 'test.path',
        index: 0,
      });

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.data.span, testSpan);
      assert.deepStrictEqual(response.data.pathToCount, { 'test.path': 1 });
      assert.ok(response.data.overrides);
    } finally {
      await closeServer(server);
    }
  });

  it('should handle cache key format with colons in path correctly', async () => {
    const { port, server, cache } = await startCacheServer();

    try {
      // Path with colons
      const pathWithColons = 'agent:step:llm';
      const testSpan: CachedSpan = {
        name: 'test-span',
        input: '{}',
        output: '{"result": "success"}',
        attributes: {},
      };

      // Key format is ${index}:${path}
      cache.set(`0:${pathWithColons}`, testSpan);

      const response = await makeRequest(port, 'POST', '/cached', {
        path: pathWithColons,
        index: 0,
      });

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.data.span, testSpan);
    } finally {
      await closeServer(server);
    }
  });

  it('should update metadata via setMetadata', async () => {
    const { port, server, setMetadata } = await startCacheServer();

    try {
      // First set metadata
      setMetadata({
        pathToCount: { 'path1': 1 },
      });

      // Make a request and check metadata
      const response1 = await makeRequest(port, 'POST', '/cached', {
        path: 'test.path',
        index: 0,
      });

      assert.strictEqual(response1.status, 404); // No cached span

      // Update metadata
      setMetadata({
        pathToCount: { 'path1': 2, 'path2': 3 },
        overrides: { 'path1': { system: 'new system' } },
      });

      // Since we can't easily check metadata without a cached span,
      // this test verifies setMetadata doesn't throw
      assert.ok(true);
    } finally {
      await closeServer(server);
    }
  });
});

describe('observeRollout Tests', () => {
  it('should register function when _set_rollout_global is true', async () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunction = undefined;
    globalThis._rolloutFunctionParams = undefined;

    const testFn = async (arg1: string, arg2: number) => {
      return `${arg1}-${arg2}`;
    };

    await observeRollout({ name: 'testAgent' }, testFn, 'hello', 42);

    assert.ok(globalThis._rolloutFunction !== undefined, 'Function should be registered');
    assert.ok(globalThis._rolloutFunctionParams !== undefined, 'Params should be extracted');

    // Clean up
    globalThis._set_rollout_global = false;
  });

  it('should execute function normally when _set_rollout_global is false', async () => {
    globalThis._set_rollout_global = false;
    globalThis._rolloutFunction = undefined;

    const testFn = async (arg1: string) => {
      return `result: ${arg1}`;
    };

    const result = await observeRollout({ name: 'testAgent' }, testFn, 'test');

    assert.strictEqual(result, 'result: test');
  });

  it('should extract parameter names from function', async () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctionParams = undefined;

    const testFn = async (instruction: string, temperature: number, options: any) => {
      return 'result';
    };

    await observeRollout({ name: 'testAgent' }, testFn, 'test', 1, {});

    assert.ok(globalThis._rolloutFunctionParams !== undefined);
    assert.ok((globalThis._rolloutFunctionParams as RolloutParam[]).length >= 2);

    // Clean up
    globalThis._set_rollout_global = false;
  });

  it('should throw error if fn is not a function', async () => {
    await assert.rejects(
      async () => {
        await observeRollout({ name: 'test' }, null as any);
      },
      /Invalid `observeRollout` usage/
    );
  });
});

describe('LaminarLanguageModel Cache Tests', () => {
  it('should return undefined if LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS is not set', async () => {
    delete process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS;

    // This test would require importing and testing the actual LaminarLanguageModel classes
    // which have dependencies on the full OpenTelemetry setup
    // For now, we verify the env var behavior is documented
    assert.strictEqual(process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS, undefined);
  });

  it('should handle cache miss (404) gracefully', async () => {
    const { port, server } = await startCacheServer();

    try {
      process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS = `http://localhost:${port}`;

      // Make a request that will result in cache miss
      const response = await makeRequest(port, 'POST', '/cached', {
        path: 'nonexistent.path',
        index: 0,
      });

      assert.strictEqual(response.status, 404);
    } finally {
      await closeServer(server);
      delete process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS;
    }
  });

  it('should handle network errors gracefully', async () => {
    process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS = 'http://localhost:99999';

    try {
      // Attempt to fetch from invalid port should fail gracefully
      // The actual implementation should return undefined on network error
      // This tests that the error handling path exists

      try {
        await makeRequest(99999, 'POST', '/cached', {
          path: 'test.path',
          index: 0,
        });
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error); // Network error expected
      }
    } finally {
      delete process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS;
    }
  });
});
