import { LaminarClient } from '@lmnr-ai/client';
import {
  type CachedSpan,
  type RolloutHandshakeEvent,
  type RolloutParam,
  type RolloutRunEvent,
  type WorkerConfig,
} from '@lmnr-ai/types';
import chokidar from 'chokidar';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { startCacheServer } from '../../cache-server';
import { createSSEClient, SSEClient } from '../../sse-client';
import { SubprocessManager } from '../../subprocess/executor';
import { initializeLogger } from '../../utils';
import { getWorkerCommand } from '../../worker-registry';
import {
  discoverFunctionMetadata,
  EXTENSIONS_TO_DISCOVER_METADATA,
} from './metadata';

const logger = initializeLogger();

export interface DevOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  grpcPort?: number;
  function?: string;
  frontendPort?: number;
  externalPackages?: string[];
  dynamicImportsToSkip?: string[];
  command?: string;
  commandArgs?: string[];
  pythonModule?: string; // Python module path (e.g., 'src.myfile')
}

function newUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return uuidv4();
}

function getFrontendUrl(baseUrl?: string, frontendPort?: number): string {
  let url = baseUrl ?? 'https://api.lmnr.ai';
  if (url === 'https://api.lmnr.ai') {
    url = 'https://www.laminar.sh';
  }
  url = url.replace(/\/$/, '');

  if (/localhost|127\.0\.0\.1/.test(url)) {
    const port = frontendPort ?? url.match(/:\d{1,5}$/g)?.[0]?.slice(1) ?? 5667;
    url = url.replace(/:\d{1,5}$/g, '');
    return `${url}:${port}`;
  }

  return url;
}

/**
 * Parses request arguments, attempting JSON parse for strings
 */
const tryParseArg = (arg: unknown) => {
  if (typeof arg === 'string') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return JSON.parse(arg);
    } catch {
      return arg;
    }
  }
  return arg;
};

/**
 * Handles a run event from the backend
 */
const handleRunEvent = async (
  event: RolloutRunEvent,
  sessionId: string,
  filePathOrModule: string,
  client: LaminarClient,
  cacheServerPort: number,
  cache: Map<string, CachedSpan>,
  setMetadata: (metadata: any) => void,
  options: DevOptions,
  subprocessManager: SubprocessManager,
): Promise<void> => {
  logger.debug('Received run event');

  const { trace_id, path_to_count, args: rawArgs, overrides } = event.data;

  const parsedArgs = Array.isArray(rawArgs)
    ? rawArgs.map(tryParseArg)
    : (Object.fromEntries(
      Object.entries(rawArgs).map(([key, value]) => [key, tryParseArg(value)]),
    ) as Record<string, any>);

  cache.clear();
  setMetadata({
    pathToCount: {},
    overrides: overrides,
  });

  try {
    // Check if we should populate cache from a previous trace
    if (!trace_id || trace_id.trim() === '') {
      logger.info('No spans in cache, starting fresh');
    } else {
      // Query spans from the backend to populate cache
      const paths = Object.keys(path_to_count || {});
      if (paths.length === 0) {
        logger.info('No spans to cache, starting fresh');
      } else {
        const query = `
          SELECT name, input, output, attributes, path
          FROM spans
          WHERE trace_id = {traceId:UUID}
            AND path IN {paths:String[]}
          ORDER BY start_time ASC
        `;

        logger.debug(`Querying spans from trace ${trace_id}...`);
        const spans = await client.sql.query(query, {
          traceId: trace_id,
          paths: paths,
        });
        logger.debug(`Received ${spans.length} spans from backend`);

        // Group spans by path and filter to first N per path
        const spansByPath: Record<string, any[]> = {};
        for (const span of spans) {
          const path = span.path as string;
          if (!spansByPath[path]) {
            spansByPath[path] = [];
          }
          spansByPath[path].push(span);
        }

        for (const [path, pathSpans] of Object.entries(spansByPath)) {
          const maxCount = path_to_count?.[path] || 0;
          const spansToCache = pathSpans.slice(0, maxCount);

          spansToCache.forEach((span, index) => {
            // Parse JSON fields
            let parsedInput = span.input;
            let parsedOutput = span.output;
            let parsedAttributes = span.attributes;

            try {
              parsedInput =
                typeof span.input === 'string' ? JSON.parse(span.input) : span.input;
            } catch {
              // Keep as string
            }

            try {
              parsedOutput =
                typeof span.output === 'string' ? span.output : JSON.stringify(span.output);
            } catch {
              parsedOutput = String(span.output);
            }

            try {
              parsedAttributes =
                typeof span.attributes === 'string'
                  ? JSON.parse(span.attributes)
                  : span.attributes;
            } catch {
              parsedAttributes = {};
            }

            const cachedSpan: CachedSpan = {
              name: span.name,
              input: parsedInput,
              output: parsedOutput,
              attributes: parsedAttributes,
            };

            const cacheKey = `${index}:${path}`;
            cache.set(cacheKey, cachedSpan);
          });

          logger.info(`Cached ${spansToCache.length} spans for path: ${path}`);
        }

        // Store metadata in cache server
        setMetadata({
          pathToCount: path_to_count || {},
          overrides,
        });
      }
    }

    // Parse baseUrl similar to how evaluations does it
    const baseUrl = options.baseUrl ?? process.env.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const httpPort =
      options.port ??
      (baseUrl.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const grpcPort = options.grpcPort ?? 8443;

    // Prepare environment variables for child process
    const env: Record<string, string> = {
      LMNR_ROLLOUT_SESSION_ID: sessionId,
      LMNR_ROLLOUT_STATE_SERVER_ADDRESS: `http://localhost:${cacheServerPort}`,
    };

    // Prepare worker configuration
    const workerConfig: WorkerConfig = {
      filePath: options.pythonModule ? undefined : filePathOrModule,
      modulePath: options.pythonModule,
      functionName: options.function,
      args: parsedArgs,
      env,
      cacheServerPort,
      baseUrl,
      projectApiKey: options.projectApiKey,
      httpPort,
      grpcPort,
      externalPackages: options.externalPackages,
      dynamicImportsToSkip: options.dynamicImportsToSkip,
    };

    // Get worker command
    const workerCommand = options.command
      ? { command: options.command, args: options.commandArgs ?? [] }
      : getWorkerCommand(options.pythonModule ? undefined : filePathOrModule, options);

    try {
      await client.rolloutSessions.setStatus({
        sessionId,
        status: 'RUNNING',
      });
    } catch (error: any) {
      logger.error(
        `Error setting rollout session status: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Execute the rollout function in subprocess
    await subprocessManager.execute({
      command: workerCommand.command,
      args: workerCommand.args,
      config: workerConfig,
    });

    try {
      await client.rolloutSessions.setStatus({
        sessionId,
        status: 'FINISHED',
      });
    } catch (error: any) {
      logger.error(
        `Error setting rollout session status: ${error instanceof Error ? error.message : error}`,
      );
    }
  } catch (error: any) {
    logger.error(`Error handling run event: ${error instanceof Error ? error.message : error}`);
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
    try {
      await client.rolloutSessions.setStatus({
        sessionId,
        status: 'FINISHED',
      });
    } catch (error: any) {
      logger.error(
        `Error setting rollout session status: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
};

/**
 * Main dev command handler
 */
export async function runDev(filePath?: string, options: DevOptions = {}): Promise<void> {
  // Determine the actual path/module to use
  const isPythonModule = !!options.pythonModule;
  const filePathOrModule = filePath || options.pythonModule!;
  let didLogHandshake = false;

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
  const { port: cacheServerPort, server: cacheServer, cache, setMetadata } =
    await startCacheServer();
  logger.debug(`Cache server started on port ${cacheServerPort}`);

  // Create subprocess manager
  const subprocessManager = new SubprocessManager();

  // Get function metadata (name and params)
  let functionName = options.function;
  let params: RolloutParam[] = [];

  try {
    // Check if we should discover metadata
    const shouldDiscover =
      isPythonModule ||
      (filePath && EXTENSIONS_TO_DISCOVER_METADATA.includes(path.extname(filePath)));

    if (shouldDiscover) {
      logger.debug('Discovering rollout functions...');
      const metadata = await discoverFunctionMetadata(filePathOrModule, options);
      functionName = metadata.functionName;
      params = metadata.params;

      logger.info(`Serving function: ${functionName}`);
      logger.debug(`Function parameters: ${JSON.stringify(params, null, 2)}`);
    } else if (filePath) {
      // Unsupported file type
      functionName = options.function || path.basename(filePath, path.extname(filePath));
      logger.warn(`Metadata discovery not available for ${path.extname(filePath)} files`);
    }
  } catch (error) {
    logger.error(
      'Failed to discover rollout functions: ' +
      (error instanceof Error ? error.message : String(error)),
    );
    cacheServer.close();
    throw error;
  }

  // Setup file watcher for hot reload
  logger.debug('Setting up file watcher...');
  const watcher = chokidar.watch('.', {
    ignored: (path: string) => {
      const ignoredDirs = [
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        'coverage',
        '.turbo',
        'tmp',
        'temp',
        'venv',
        '.venv',
        'virtualenv',
        '.virtualenv',
        '__pycache__',
        '.pytest_cache',
        '.ruff_cache',
        '.mypy_cache',
        '.cache',
        '.DS_Store',
      ];

      const pathSegments = path.split(/[/\\]/);
      if (pathSegments.some((segment) => ignoredDirs.includes(segment))) {
        return true;
      }

      if (path.endsWith('.log') || path.endsWith('.map')) {
        return true;
      }

      return false;
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  // Create SSE client
  logger.debug('Setting up SSE client...');
  let sseClient: SSEClient | null = null;

  try {
    sseClient = createSSEClient({
      client,
      sessionId,
      params: params,
      name: functionName ?? '',
    });

    // Track if we're currently processing a run event (including metadata discovery)
    // This prevents race conditions during the build/load phase
    let currentRunPromise: Promise<void> | null = null;

    // Register all event listeners BEFORE connecting
    sseClient.on('heartbeat', () => {
      logger.debug('Heartbeat received');
    });

    sseClient.on('run', (event: RolloutRunEvent) => {
      // Check if we're already processing a run (including metadata discovery)
      if (currentRunPromise !== null) {
        logger.warn('Already processing a run event, skipping new run');
        return;
      }

      // Create a promise chain that ensures metadata discovery completes before execution
      currentRunPromise = (async () => {
        try {
          // Check if a reload is scheduled and perform it before the run
          if (reloadScheduled) {
            logger.info('Reloading function metadata before run...');
            reloadScheduled = false;

            // Re-discover function metadata for supported file types
            // IMPORTANT: This builds and loads the module, so we must await it
            if (
              isPythonModule ||
              (filePath &&
                EXTENSIONS_TO_DISCOVER_METADATA.includes(path.extname(filePath)))
            ) {
              try {
                const metadata = await discoverFunctionMetadata(filePathOrModule, options);
                logger.debug(`Updated function metadata: ${metadata.functionName}`);
                logger.debug(`Updated parameters: ${JSON.stringify(metadata.params, null, 2)}`);

                // Update the SSE client with new metadata
                if (sseClient) {
                  sseClient.updateMetadata(metadata.params, metadata.functionName);
                  logger.debug('Notified backend of metadata changes');
                }
              } catch (error: any) {
                logger.error(
                  'Failed to update function metadata: ' +
                  (error instanceof Error ? error.message : String(error)),
                );
                if (error instanceof Error && error.stack) {
                  logger.debug(`Stack trace: ${error.stack}`);
                }
                // Don't proceed with run if metadata discovery failed
                return;
              }
            }
          }

          // After metadata reload completes (if needed), handle the run event
          await handleRunEvent(
            event,
            sessionId,
            filePathOrModule,
            client,
            cacheServerPort,
            cache,
            setMetadata,
            options,
            subprocessManager,
          );
        } catch (error) {
          logger.error(
            'Unhandled error in run event handler: ' +
            (error instanceof Error ? error.message : String(error)),
          );
        } finally {
          // Clear the promise so the next run can proceed
          currentRunPromise = null;
        }
      })();
    });

    sseClient.on('handshake', (event: RolloutHandshakeEvent) => {
      const projectId = event.data.project_id;
      const sessionId = event.data.session_id;
      const frontendUrl = getFrontendUrl(options.baseUrl, options.frontendPort);
      if (!didLogHandshake) {
        logger.info(
          `View your session at ${frontendUrl}/project/${projectId}/rollout-sessions/${sessionId}`,
        );
      }
      didLogHandshake = true;
    });

    sseClient.on('error', (error: Error) => {
      logger.warn(`Error connecting to backend: ${error.message}`);
    });

    sseClient.on('reconnecting', () => {
      logger.info('Reconnecting to backend...');
    });

    sseClient.on('heartbeat_timeout', () => {
      logger.debug('Heartbeat timeout, reconnecting...');
    });

    sseClient.on('stop', () => {
      logger.debug('Cancelling current run...');
      subprocessManager.kill();
      // Note: currentRunPromise will be cleared by the finally block
      // when the promise chain completes
      logger.info('Current run cancelled');
    });

    // Setup file change handler for hot reload with debouncing
    let reloadTimeout: NodeJS.Timeout | null = null;
    let reloadScheduled = false;
    watcher.on('change', (changedPath: string) => {
      logger.info(`File changed: ${changedPath}, scheduling reload...`);

      // Clear any pending debounce timeout
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
      }

      // Debounce the reload flag to avoid multiple rapid file changes
      reloadTimeout = setTimeout(() => {
        logger.debug('Marking reload as scheduled for next run...');
        reloadTimeout = null;
        reloadScheduled = true;
      }, 100); // Wait 100ms after the last change before marking reload
    });

    // Handle graceful shutdown
    const shutdown = () => {
      logger.debug('Shutting down...');

      // Clear any pending reload timeout and scheduled reload
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
        reloadTimeout = null;
      }
      reloadScheduled = false;

      // Close file watcher
      logger.debug('Closing file watcher...');
      watcher
        .close()
        .catch((error: any) => {
          logger.error(
            `Failed to close file watcher: ${error instanceof Error ? error.message : error}`,
          );
        });

      // Kill any running subprocess
      subprocessManager.kill();

      // Delete the rollout session
      logger.debug('Deleting rollout session...');
      client.rolloutSessions
        .delete({ sessionId })
        .then(() => {
          if (sseClient) {
            sseClient.shutdown();
          }

          cacheServer.close(() => {
            logger.debug('Cache server closed');
          });
          process.exit(0);
        })
        .catch((error: any) => {
          logger.warn(
            `Failed to delete rollout session: ${error instanceof Error ? error.message : error}`,
          );
          process.exit(1);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep stdin open to prevent process from exiting
    process.stdin.resume();

    // Connect to backend and start listening
    logger.debug('Connecting to backend...');
    await sseClient.connectAndListen();
  } catch (error) {
    logger.error(
      'Failed to start dev command: ' + (error instanceof Error ? error.message : String(error)),
    );

    // Try to delete the rollout session before exiting
    try {
      await client.rolloutSessions.delete({ sessionId });
    } catch {
      // Ignore delete errors during error cleanup
    }

    await watcher.close();
    cacheServer.close(() => {
      process.exit(1);
    });
  }
}
