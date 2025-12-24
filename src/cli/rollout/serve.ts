import * as esbuild from 'esbuild';

import { LaminarClient } from '../../client';
import { Laminar } from '../../laminar';
import { getDirname, initializeLogger, newUUID } from '../../utils';
import { CachedSpan, startCacheServer } from './cache-server';
import { createSSEClient, SSEClient } from './sse-client';
import { RolloutHandshakeEvent, RolloutRunEvent } from '../../types';

const logger = initializeLogger();

interface ServeOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  function?: string;
}

/**
 * Loads and executes a module to register rollout functions
 */
function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}): void {
  globalThis._rolloutFunctions = new Map();
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
 * Selects the appropriate rollout function from the registered functions
 */
function selectRolloutFunction(
  requestedFunctionName?: string
): { fn: (...args: any[]) => any; params: any[]; name: string } {
  if (!globalThis._rolloutFunctions || globalThis._rolloutFunctions.size === 0) {
    throw new Error(
      'No rollout functions found in file. Make sure you are using observe with rolloutEntrypoint: true'
    );
  }

  // If a specific function is requested, use that
  if (requestedFunctionName) {
    const selected = globalThis._rolloutFunctions.get(requestedFunctionName);
    if (!selected) {
      const available = Array.from(globalThis._rolloutFunctions.keys()).join(', ');
      throw new Error(
        `Function '${requestedFunctionName}' not found. Available functions: ${available}`
      );
    }
    return selected;
  }

  // If only one function, auto-select it
  if (globalThis._rolloutFunctions.size === 1) {
    const [selected] = Array.from(globalThis._rolloutFunctions.values());
    return selected;
  }

  // Multiple functions found without explicit selection
  const available = Array.from(globalThis._rolloutFunctions.keys()).join(', ');
  throw new Error(
    `Multiple rollout functions found: ${available}. Use --function to specify which one to serve.`
  );
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
  options: ServeOptions,
  functionName?: string,
): Promise<void> {
  logger.info('Received run event');

  const { trace_id, path_to_count, args, overrides } = event.data;

  try {
    // Check if we should populate cache from a previous trace
    if (!trace_id || trace_id.trim() === '') {
      logger.info('No trace_id provided, running without cached LLM calls');
      // Clear cache and metadata since we're running fresh
      cache.clear();
      setMetadata({
        pathToCount: {},
        overrides: overrides,
      });
    } else {
      // Query spans from the backend to populate cache
      const paths = Object.keys(path_to_count || {});
      if (paths.length === 0) {
        logger.warn('No paths in path_to_count, skipping cache population');
        cache.clear();
        setMetadata({
          pathToCount: {},
          overrides: overrides,
        });
      } else {
        const query = `
          SELECT name, input, output, attributes, path, start_time
          FROM spans
          WHERE trace_id = {traceId:UUID}
            AND span_type = 'LLM'
            AND path IN {paths:String[]}
          ORDER BY start_time ASC
        `;

        logger.info(`Querying spans from trace ${trace_id}...`);
        const spans = await client.sql.query(query, {
          traceId: trace_id,
          paths: paths,
        });
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
          const maxCount = path_to_count?.[path] || 0;
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

        // Store metadata in cache server
        setMetadata({
          pathToCount: path_to_count || {},
          overrides: overrides,
        });
      }
    }

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

    // Select the appropriate rollout function
    const selectedFunction = selectRolloutFunction(functionName);
    logger.info(`Selected function: ${selectedFunction.name}`);

    // Initialize Laminar with CLI options (will be no-op if already initialized by user)
    // Parse baseUrl similar to how evaluations does it
    const baseUrl = options.baseUrl ?? process.env.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const httpPort = options.port ?? (
      baseUrl.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443
    );
    const urlWithoutSlash = baseUrl.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    const baseHttpUrl = `${urlWithoutSlash}:${httpPort}`;

    logger.info('Initializing Laminar...');
    Laminar.initialize({
      projectApiKey: options.projectApiKey,
      baseUrl: baseUrl,
      baseHttpUrl,
      httpPort,
    });

    // Execute the rollout function with args
    // Convert args object to array of arguments based on parameter names
    logger.info('Executing rollout function...');
    const orderedArgs = selectedFunction.params.map(param => args[param.name]);
    logger.info(`Calling function with args: ${JSON.stringify(orderedArgs)}`);
    const result = await selectedFunction.fn(...orderedArgs);
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

  // Initialize Laminar client
  const client = new LaminarClient({
    baseUrl: options.baseUrl,
    projectApiKey: options.projectApiKey,
    port: options.port,
  });

  // Start cache server
  logger.debug('Starting cache server...');
  const { port: cacheServerPort, server: cacheServer, cache, setMetadata } = await startCacheServer();
  logger.debug(`Cache server started on port ${cacheServerPort}`);

  // Build file to discover and select rollout functions
  logger.debug('Discovering rollout functions...');
  let selectedFunction: { fn: (...args: any[]) => any; params: any[]; name: string };

  try {
    const moduleText = await buildFile(filePath);
    loadModule({
      filename: filePath,
      moduleText,
    });

    // Select the appropriate function
    selectedFunction = selectRolloutFunction(options.function);
    logger.info(`Serving function: ${selectedFunction.name}`);
    logger.debug(`Function parameters: ${JSON.stringify(selectedFunction.params)}`);
  } catch (error) {
    logger.error(`Failed to discover rollout functions: ${error instanceof Error ? error.message : error}`);
    throw error;
  }

  // Create SSE client (don't connect yet)
  logger.debug('Setting up SSE client...');
  let sseClient: SSEClient | null = null;

  try {
    sseClient = createSSEClient({
      baseUrl: client['baseUrl'], // Access private property for baseUrl
      sessionId,
      projectApiKey: client['projectApiKey'], // Access private property for projectApiKey
      params: selectedFunction.params || [],
    });

    // Register all event listeners BEFORE connecting
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
        options,
        options.function,
      );
    });

    sseClient.on('handshake', (event: RolloutHandshakeEvent) => {
      const projectId = event.data.project_id;
      const sessionId = event.data.session_id;
      logger.info(`View your session at https://laminar.sh/project/${projectId}/rolloutes/${sessionId}`);
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

    // Now connect after listeners are registered
    logger.debug('Connecting to backend...');
    await sseClient.connect();
    logger.debug('Connected to backend. Waiting for run events...');

    // Handle graceful shutdown
    const shutdown = () => {
      logger.debug('Shutting down...');

      if (sseClient) {
        sseClient.shutdown();
      }

      cacheServer.close(() => {
        logger.debug('Cache server closed');
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
