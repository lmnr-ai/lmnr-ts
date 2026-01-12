import { LaminarClient } from '@lmnr-ai/client';
import { RolloutHandshakeEvent, RolloutParam, RolloutRunEvent, WorkerConfig } from '@lmnr-ai/types';
import chokidar from 'chokidar';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { CachedSpan, startCacheServer } from '../cache-server';
import { createSSEClient, SSEClient } from '../sse-client';
import { SubprocessManager } from '../subprocess/executor';
import { initializeLogger } from '../utils';
import { getWorkerCommand } from '../worker-registry';

interface FunctionMetadata {
  name: string;          // The span name from observe({ name: '...' })
  exportName: string;    // The actual export/variable name
  params: RolloutParam[];
}

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
async function handleRunEvent(
  event: RolloutRunEvent,
  sessionId: string,
  filePath: string,
  client: LaminarClient,
  cacheServerPort: number,
  cache: Map<string, CachedSpan>,
  setMetadata: (metadata: any) => void,
  options: DevOptions,
  subprocessManager: SubprocessManager,
): Promise<void> {
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
      filePath,
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
    const workerCommand = options.command && options.commandArgs
      ? { command: options.command, args: options.commandArgs }
      : getWorkerCommand(filePath);

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
}

/**
 * Main dev command handler
 */
export async function runDev(filePath: string, options: DevOptions = {}): Promise<void> {
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
  // For TypeScript files, build and load to discover functions
  let functionName = options.function;
  let params: any[] = [];

  try {
    if (['.ts', '.tsx'].includes(path.extname(filePath))) {
      logger.debug('Discovering rollout functions...');

      /* eslint-disable @typescript-eslint/no-require-imports */
      const { extractRolloutFunctions } = require('@lmnr-ai/lmnr/dist/cli/worker/ts-parser.cjs');
      const {
        buildFile,
        loadModule,
        selectRolloutFunction,
      } = require('@lmnr-ai/lmnr/dist/cli/worker/build.cjs');
      /* eslint-enable @typescript-eslint/no-require-imports */

      // Extract TypeScript metadata
      let paramsMetadata: Map<string, FunctionMetadata> | undefined;
      try {
        paramsMetadata = extractRolloutFunctions(filePath);
        logger.debug(`Extracted TypeScript metadata for ${paramsMetadata?.size} functions`);
      } catch (error) {
        logger.warn(
          'Failed to extract TypeScript metadata, falling back to runtime parsing: ' +
          (error instanceof Error ? error.message : String(error)),
        );
      }

      // Build and load the module
      const moduleText = await buildFile(filePath, {
        externalPackages: options.externalPackages,
        dynamicImportsToSkip: options.dynamicImportsToSkip,
      });
      loadModule({
        filename: filePath,
        moduleText,
      });

      // Select the appropriate function
      const selectedFunction = selectRolloutFunction(options.function);

      // If we have TypeScript metadata, match by span name and enrich params
      if (paramsMetadata) {
        logger.debug(`Available TS metadata keys: ${Array.from(paramsMetadata.keys()).join(', ')}`);
        logger.debug(
          `Looking for span name: ${selectedFunction.name} ` +
          `(runtime key: ${selectedFunction.exportName})`,
        );

        // Search for metadata by span name
        let foundMetadata: FunctionMetadata | null = null;
        for (const [exportName, metadata] of paramsMetadata.entries()) {
          logger.debug(`Checking ${exportName}: span name = ${metadata.name}`);
          if (metadata.name === selectedFunction.name) {
            foundMetadata = metadata;
            logger.debug(`Found match! Export name: ${exportName}, span name: ${metadata.name}`);
            break;
          }
        }

        if (foundMetadata) {
          selectedFunction.params = foundMetadata.params;
          logger.debug(`Using TypeScript metadata for span: ${selectedFunction.name}`);
        } else {
          logger.warn(`No TypeScript metadata found for span name: ${selectedFunction.name}`);
        }
      }

      functionName = selectedFunction.name;
      params = selectedFunction.params || [];

      logger.info(`Serving function: ${functionName}`);
      logger.debug(`Function parameters: ${JSON.stringify(params, null, 2)}`);
    } else {
      // For non-TS files, use fallback
      functionName = options.function || path.basename(filePath, path.extname(filePath));
      logger.info(`Serving function: ${functionName} (non-TS file, params not extracted)`);
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

    // Register all event listeners BEFORE connecting
    sseClient.on('heartbeat', () => {
      logger.debug('Heartbeat received');
    });

    sseClient.on('run', (event: RolloutRunEvent) => {
      handleRunEvent(
        event,
        sessionId,
        filePath,
        client,
        cacheServerPort,
        cache,
        setMetadata,
        options,
        subprocessManager,
      ).catch((error) => {
        logger.error(
          'Unhandled error in run event handler: ' +
          (error instanceof Error ? error.message : String(error)),
        );
      });
    });

    sseClient.on('handshake', (event: RolloutHandshakeEvent) => {
      const projectId = event.data.project_id;
      const sessionId = event.data.session_id;
      const frontendUrl = getFrontendUrl(options.baseUrl, options.frontendPort);
      logger.info(
        `View your session at ${frontendUrl}/project/${projectId}/rollout-sessions/${sessionId}`,
      );
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
      logger.info('Current run cancelled');
    });

    // Setup file change handler for hot reload
    watcher.on('change', (changedPath: string) => {
      logger.info(`File changed: ${changedPath}, reloading...`);

      // Cancel running subprocess
      if (subprocessManager.isRunning()) {
        logger.warn('Cancelling current run due to file change');
        subprocessManager.kill();
      }
    });

    // Handle graceful shutdown
    const shutdown = () => {
      logger.debug('Shutting down...');

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
