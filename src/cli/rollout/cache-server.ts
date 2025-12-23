import * as http from 'http';

export interface CachedSpan {
  name: string;
  input: string;  // JSON string
  output: string; // JSON string
  attributes: Record<string, any>; // Already parsed
}

export interface CacheMetadata {
  pathToCount: Record<string, number>;
  overrides?: Record<string, { system?: string; tools?: any[] }>;
}

interface CacheServerResult {
  port: number;
  server: http.Server;
  cache: Map<string, CachedSpan>;
  setMetadata: (metadata: CacheMetadata) => void;
}

const DEFAULT_START_PORT = 35667;

/**
 * Finds an available port starting from the given port number
 */
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(startPort, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try the next one
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Parses request body as JSON
 */
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Starts a local cache server for storing and retrieving cached LLM responses
 * during rollout debugging sessions.
 * 
 * @param startPort - Optional starting port number (defaults to 35667)
 * @returns Server information including port, server instance, cache, and metadata setter
 */
export async function startCacheServer(startPort: number = DEFAULT_START_PORT): Promise<CacheServerResult> {
  const cache = new Map<string, CachedSpan>();
  let metadata: CacheMetadata = {
    pathToCount: {},
    overrides: undefined,
  };

  const server = http.createServer(async (req, res) => {
    // Set CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Cached response endpoint
    if (req.method === 'POST' && req.url === '/cached') {
      try {
        const body = await parseBody(req);
        const { path, index } = body;

        if (typeof path !== 'string' || typeof index !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request: path (string) and index (number) required' }));
          return;
        }

        // Cache key is ${index}:${path} to handle colons in paths
        const cacheKey = `${index}:${path}`;
        const cachedSpan = cache.get(cacheKey);

        if (!cachedSpan) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cache miss' }));
          return;
        }

        // Return cached span with metadata
        const response = {
          span: cachedSpan,
          pathToCount: metadata.pathToCount,
          overrides: metadata.overrides,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }));
      }
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const port = await findAvailablePort(startPort);

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      resolve({
        port,
        server,
        cache,
        setMetadata: (newMetadata: CacheMetadata) => {
          metadata = newMetadata;
        },
      });
    });

    server.on('error', reject);
  });
}
