import * as esbuild from 'esbuild';

import { LaminarClient } from '../../client';
import { getDirname, initializeLogger, newUUID } from '../../utils';
import { CachedSpan, startCacheServer } from './cache-server';
import { createSSEClient, SSEClient } from './sse-client';
import { RolloutRunEvent } from '../../types';

const logger = initializeLogger();

interface ServeOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Loads and executes a module to register the rollout function
 */
function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}): void {
  globalThis._rolloutFunction = undefined;
  globalThis._rolloutFunctionParams = undefined;
  globalThis._set_rollout_global = true;

  const __filename = filename;
  const __dirname = getDirname();

  /* eslint-disable @typescript-eslint/no-implied-eval */
  new Function(
    "require",
    "module",
    "__filename",
    "__dirname",
    moduleText,
  )(
    require,
    module,
    __filename,
    __dirname,
  );
  /* eslint-enable @typescript-eslint/no-implied-eval */
}

/**
 * Builds a file using esbuild
 */
async function buildFile(filePath: string): Promise<string> {
  const result = await esbuild.build({
    bundle: true,
    platform: "node" as esbuild.Platform,
    entryPoints: [filePath],
    outfile: `tmp_out_${filePath}.js`,
    write: false,
    external: [
      "node_modules/*",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "playwright-core",
      "fsevents",
    ],
    treeShaking: true,
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("Failed to build file");
  }

  return result.outputFiles[0].text;
}

/**
 * Handles a run event from the backend
 */
async function handleRunEvent(
  event: RolloutRunEvent,
  sessionId: string,
  filePath: string,
  client: LaminarClient,
  cacheServerPort: number,
  cache: Map<string, CachedSpan>,
  setMetadata: (metadata: any) => void,
): Promise<void> {
  logger.info('Received run event');

  const { trace_id, path_to_count, args, overrides } = event.data;

  try {
    // Query spans from the backend
    const paths = Object.keys(path_to_count);
    if (paths.length === 0) {
      logger.warn('No paths in path_to_count, skipping cache population');
    } else {
      const pathsStr = paths.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ');
      const query = `
        SELECT name, input, output, attributes, path, start_time
        FROM spans
        WHERE trace_id = '${trace_id}'
          AND span_type = 'LLM'
          AND path IN (${pathsStr})
        ORDER BY start_time ASC
      `;

      logger.info('Querying spans from backend...');
      const spans = await client.sql.query(query);
      logger.info(`Received ${spans.length} spans from backend`);

      // Group spans by path and filter to first N per path
      const spansByPath: Record<string, any[]> = {};
      for (const span of spans) {
        const path = span.path as string;
        if (!spansByPath[path]) {
          spansByPath[path] = [];
        }
        spansByPath[path].push(span);
      }

      // Clear cache and populate with new data
      cache.clear();

      for (const [path, pathSpans] of Object.entries(spansByPath)) {
        const maxCount = path_to_count[path] || 0;
        const spansToCache = pathSpans.slice(0, maxCount);

        spansToCache.forEach((span, index) => {
          // Parse JSON fields
          let parsedInput = span.input;
          let parsedOutput = span.output;
          let parsedAttributes = span.attributes;

          try {
            parsedInput = typeof span.input === 'string' ? JSON.parse(span.input) : span.input;
          } catch (e) {
            // Keep as string
          }

          try {
            parsedOutput = typeof span.output === 'string' ? span.output : JSON.stringify(span.output);
          } catch (e) {
            parsedOutput = String(span.output);
          }

          try {
            parsedAttributes = typeof span.attributes === 'string' ? JSON.parse(span.attributes) : span.attributes;
          } catch (e) {
            parsedAttributes = {};
          }

          const cachedSpan: CachedSpan = {
            name: span.name,
            input: parsedInput,
            output: parsedOutput,
            attributes: parsedAttributes,
          };

          // Cache key is ${index}:${path}
          const cacheKey = `${index}:${path}`;
          cache.set(cacheKey, cachedSpan);
        });

        logger.info(`Cached ${spansToCache.length} spans for path: ${path}`);
      }
    }

    // Store metadata in cache server
    setMetadata({
      pathToCount: path_to_count,
      overrides: overrides,
    });

    // Set environment variables
    process.env.LMNR_ROLLOUT_SESSION_ID = sessionId;
    process.env.LAMINAR_ROLLOUT_STATE_SERVER_ADDRESS = `http://localhost:${cacheServerPort}`;

    // Build and load the user file
    logger.info('Building user file...');
    const moduleText = await buildFile(filePath);

    logger.info('Loading user file...');
    loadModule({
      filename: filePath,
      moduleText,
    });

    if (!globalThis._rolloutFunction) {
      logger.error('No rollout function found in file. Make sure you are using observeRollout wrapper.');
      return;
    }

    // Execute the rollout function with args
    logger.info('Executing rollout function...');
    const result = await globalThis._rolloutFunction(args);
    logger.info('Rollout function completed successfully');
    logger.info(`Result: ${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    logger.error(`Error handling run event: ${error instanceof Error ? error.message : error}`);
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
  }
}

/**
 * Main serve command handler
 */
export async function runServe(
  filePath: string,
  options: ServeOptions = {},
): Promise<void> {
  // Generate session ID
  const sessionId = newUUID();
  logger.info(`Session ID: ${sessionId}`);

  // Initialize Laminar client
  const client = new LaminarClient({
    baseUrl: options.baseUrl,
    projectApiKey: options.projectApiKey,
    port: options.port,
  });

  // Start cache server
  logger.info('Starting cache server...');
  const { port: cacheServerPort, server: cacheServer, cache, setMetadata } = await startCacheServer();
  logger.info(`Cache server started on port ${cacheServerPort}`);

  // Build file to extract parameters
  logger.info('Parsing function parameters...');
  try {
    const moduleText = await buildFile(filePath);
    loadModule({
      filename: filePath,
      moduleText,
    });

    if (!globalThis._rolloutFunctionParams) {
      logger.warn('Could not extract function parameters. Continuing with empty params.');
      globalThis._rolloutFunctionParams = [];
    }

    logger.info(`Function parameters: ${JSON.stringify(globalThis._rolloutFunctionParams)}`);
  } catch (error) {
    logger.error(`Failed to parse function parameters: ${error instanceof Error ? error.message : error}`);
    logger.info('Continuing with empty params.');
    globalThis._rolloutFunctionParams = [];
  }

  // Connect to SSE endpoint
  logger.info('Connecting to backend...');
  let sseClient: SSEClient | null = null;

  try {
    sseClient = await createSSEClient({
      baseUrl: client['baseUrl'], // Access private property for baseUrl
      sessionId,
      projectApiKey: client['projectApiKey'], // Access private property for projectApiKey
      params: globalThis._rolloutFunctionParams || [],
    });

    logger.info('Connected to backend. Waiting for run events...');

    sseClient.on('heartbeat', () => {
      logger.debug('Heartbeat received');
    });

    sseClient.on('run', async (event: RolloutRunEvent) => {
      await handleRunEvent(
        event,
        sessionId,
        filePath,
        client,
        cacheServerPort,
        cache,
        setMetadata,
      );
    });

    sseClient.on('error', (error: Error) => {
      logger.error(`SSE error: ${error.message}`);
    });

    sseClient.on('reconnecting', () => {
      logger.info('Reconnecting to backend...');
    });

    sseClient.on('heartbeat_timeout', () => {
      logger.warn('Heartbeat timeout, reconnecting...');
    });

    // Handle graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down...');

      if (sseClient) {
        sseClient.shutdown();
      }

      cacheServer.close(() => {
        logger.info('Cache server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process running
    await new Promise(() => { });
  } catch (error) {
    logger.error(`Failed to start serve command: ${error instanceof Error ? error.message : error}`);

    cacheServer.close(() => {
      process.exit(1);
    });
  }
}
