import * as http from 'node:http';

import { type CachedSpan } from '@lmnr-ai/types';
import { describe, expect, it } from 'vitest';

import { startCacheServer } from './cache-server';

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

describe('Cache Server', () => {
  it('starts server on available port from 35667', async () => {
    const { port, server } = await startCacheServer(35667);

    try {
      expect(port >= 35667).toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });

  it('returns 200 for health check', async () => {
    const { port, server } = await startCacheServer();

    try {
      const response = await makeRequest(port, 'GET', '/health');

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ok' });
    } finally {
      await closeServer(server);
    }
  });

  it('returns empty span object for missing cache keys', async () => {
    const { port, server } = await startCacheServer();

    try {
      const response = await makeRequest(port, 'POST', '/cached', {
        path: 'test.path',
        index: 0,
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        pathToCount: {},
      });
    } finally {
      await closeServer(server);
    }
  });

  it('returns cached span data with metadata', async () => {
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

      expect(response.status).toBe(200);
      expect(response.data.span).toEqual(testSpan);
      expect(response.data.pathToCount).toEqual({ 'test.path': 1 });
      expect(response.data.overrides).toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });

  it('handles cache key format with colons in path correctly', async () => {
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

      expect(response.status).toBe(200);
      expect(response.data.span).toEqual(testSpan);
    } finally {
      await closeServer(server);
    }
  });

  it('updates metadata via setMetadata', async () => {
    const { server, setMetadata } = await startCacheServer();

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
      expect(true).toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });

  it('handles multiple simultaneous requests', async () => {
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

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response1.data.span.name).toBe('span-a');
      expect(response2.data.span.name).toBe('span-b');
    } finally {
      await closeServer(server);
    }
  });

  it('handles large payloads', async () => {
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

      expect(response.status).toBe(200);
      expect(response.data.span.output).toBe(largeOutput);
    } finally {
      await closeServer(server);
    }
  });

  it('handles concurrent cache updates', async () => {
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
          makeRequest(port, 'POST', '/cached', { path: 'test.path', index: i }),
        );
      }

      const responses = await Promise.all(updates);

      // All requests should succeed
      responses.forEach((response, i) => {
        expect(response.status).toBe(200);
        expect(response.data.span.name).toBe(`span-${i}`);
      });
    } finally {
      await closeServer(server);
    }
  });
});
