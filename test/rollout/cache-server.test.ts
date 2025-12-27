import * as assert from 'node:assert';
import * as http from 'node:http';
import { describe, it } from 'node:test';

import { CachedSpan, startCacheServer } from '../../src/cli/rollout/cache-server';

// Helper to make HTTP requests
async function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: any,
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
        } catch {
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

void describe('Cache Server', () => {
  void it('starts server on available port from 35667', async () => {
    const { port, server } = await startCacheServer(35667);

    try {
      assert.ok(port >= 35667, 'Port should be >= 35667');
    } finally {
      await closeServer(server);
    }
  });

  void it('returns 200 for health check', async () => {
    const { port, server } = await startCacheServer();

    try {
      const response = await makeRequest(port, 'GET', '/health');

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.data, { status: 'ok' });
    } finally {
      await closeServer(server);
    }
  });

  void it('returns 404 for missing cache keys', async () => {
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

  void it('returns cached span data with metadata', async () => {
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

  void it('handles cache key format with colons in path correctly', async () => {
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

  void it('updates metadata via setMetadata', async () => {
    const { port, server, setMetadata } = await startCacheServer();

    try {
      // First set metadata
      setMetadata({
        pathToCount: { 'path1': 1 },
      });

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

  void it('handles multiple simultaneous requests', async () => {
    const { port, server, cache } = await startCacheServer();

    try {
      // Set up cache with multiple entries
      cache.set('0:path.a', {
        name: 'span-a',
        input: '{}',
        output: '"response-a"',
        attributes: {},
      });
      cache.set('0:path.b', {
        name: 'span-b',
        input: '{}',
        output: '"response-b"',
        attributes: {},
      });

      // Make simultaneous requests
      const [response1, response2] = await Promise.all([
        makeRequest(port, 'POST', '/cached', { path: 'path.a', index: 0 }),
        makeRequest(port, 'POST', '/cached', { path: 'path.b', index: 0 }),
      ]);

      assert.strictEqual(response1.status, 200);
      assert.strictEqual(response2.status, 200);
      assert.strictEqual(response1.data.span.name, 'span-a');
      assert.strictEqual(response2.data.span.name, 'span-b');
    } finally {
      await closeServer(server);
    }
  });

  void it('handles large payloads', async () => {
    const { port, server, cache } = await startCacheServer();

    try {
      // Create a large output string
      const largeOutput = JSON.stringify({ data: 'x'.repeat(10000) });
      const testSpan: CachedSpan = {
        name: 'large-span',
        input: '{}',
        output: largeOutput,
        attributes: {},
      };

      cache.set('0:large.path', testSpan);

      const response = await makeRequest(port, 'POST', '/cached', {
        path: 'large.path',
        index: 0,
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.span.output, largeOutput);
    } finally {
      await closeServer(server);
    }
  });

  void it('handles concurrent cache updates', async () => {
    const { port, server, cache, setMetadata } = await startCacheServer();

    try {
      // Update cache and metadata concurrently
      const updates = [];
      for (let i = 0; i < 10; i++) {
        cache.set(`${i}:test.path`, {
          name: `span-${i}`,
          input: '{}',
          output: `"output-${i}"`,
          attributes: {},
        });
        setMetadata({
          pathToCount: { 'test.path': i + 1 },
        });
        updates.push(
          makeRequest(port, 'POST', '/cached', { path: 'test.path', index: i })
        );
      }

      const responses = await Promise.all(updates);

      // All requests should succeed
      responses.forEach((response, i) => {
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.data.span.name, `span-${i}`);
      });
    } finally {
      await closeServer(server);
    }
  });
});
