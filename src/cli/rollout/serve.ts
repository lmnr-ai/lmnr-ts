import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { LaminarClient } from '../../client';
import { RolloutHandshakeEvent, RolloutRunEvent } from '../../types';
import { initializeLogger, newUUID } from '../../utils';
import { buildFile, loadModule, selectRolloutFunction } from './build';
import { CachedSpan, startCacheServer } from './cache-server';
import { createSSEClient, SSEClient } from './sse-client';
import { extractRolloutFunctions } from './ts-parser';

const logger = initializeLogger();

// Track the currently running child process
let currentChildProcess: ChildProcess | null = null;

interface ServeOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  grpcPort?: number;
  function?: string;
}

/**
 * Message types from worker process
 */
interface WorkerLogMessage {
  type: 'log';
  level: 'info' | 'debug' | 'error' | 'warn';
  message: string;
}

interface WorkerResultMessage {
  type: 'result';
  data: any;
}

interface WorkerErrorMessage {
  type: 'error';
  error: string;
  stack?: string;
}

type WorkerMessage = WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage;

/**
 * Configuration sent to worker process
 */
interface WorkerConfig {
  filePath: string;
  functionName?: string;
  args: Record<string, any>;
  env: Record<string, string>;
  cacheServerPort: number;
  baseUrl: string;
  projectApiKey?: string;
  httpPort: number;
  grpcPort: number;
}

/**
 * Prefix used by worker to identify protocol messages
 */
const WORKER_MESSAGE_PREFIX = '__LMNR_WORKER__:';

/**
 * Executes a rollout function in a child process
 */
async function executeInChildProcess(config: WorkerConfig): Promise<any> {
  return new Promise((resolve, reject) => {
    // Get the path to the worker module
    // Try different possible locations based on build output structure
    // When cli.cjs is in dist/, worker.cjs is in dist/cli/rollout/
    const possiblePaths = [
      path.join(__dirname, 'cli', 'rollout', 'worker.cjs'), // From dist/ to dist/cli/rollout/
      path.join(__dirname, 'rollout', 'worker.cjs'),        // From dist/cli/ to dist/cli/rollout/
      path.join(__dirname, 'worker.cjs'),                   // Same directory
    ];

    let workerPath: string | null = null;
    // Use the first path that exists
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        workerPath = p;
        break;
      }
    }

    if (!workerPath) {
      const errorMsg = `Worker module not found.`;
      logger.error(errorMsg);
      reject(new Error(errorMsg));
      return;
    }

    // Log the worker path for debugging
    logger.debug(`Using worker path: ${workerPath}`);

    // Spawn the worker process
    const child = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    currentChildProcess = child;
    let result: any = undefined;
    let hasError = false;

    // Set up readline interface for stdout
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    // Handle messages from worker
    rl.on('line', (line: string) => {
      // Check if this is a worker protocol message or user output
      if (line.startsWith(WORKER_MESSAGE_PREFIX)) {
        // Parse worker protocol message
        try {
          const messageJson = line.substring(WORKER_MESSAGE_PREFIX.length);
          const message: WorkerMessage = JSON.parse(messageJson);

          switch (message.type) {
            case 'log':
              // Forward log messages to parent logger
              switch (message.level) {
                case 'info':
                  logger.info(message.message);
                  break;
                case 'debug':
                  logger.debug(message.message);
                  break;
                case 'error':
                  logger.error(message.message);
                  break;
                case 'warn':
                  logger.warn(message.message);
                  break;
              }
              break;

            case 'result':
              result = message.data;
              break;

            case 'error':
              hasError = true;
              logger.error(`Worker error: ${message.error}`);
              if (message.stack) {
                logger.error(message.stack);
              }
              break;
          }
        } catch {
          // If we can't parse a prefixed message, log it as an error
          logger.debug(`Failed to parse worker protocol message: ${line}`);
        }
      } else {
        // This is user output from console.log - pass it through transparently
        console.log(line);
      }
    });

    // Pass through stderr for user's console.error and capture crashes
    child.stderr.on('data', (data: Buffer) => {
      // Write directly to stderr to preserve user's error output
      process.stderr.write(data);
    });

    // Handle process exit
    child.on('exit', (code: number | null, signal: string | null) => {
      currentChildProcess = null;

      if (signal) {
        logger.info(`Worker process terminated by signal: ${signal}`);
        reject(new Error(`Worker terminated by signal: ${signal}`));
      } else if (code === 0) {
        resolve(result);
      } else {
        if (!hasError) {
          logger.error(`Worker process exited with code ${code}`);
        }
        reject(new Error(`Worker process exited with code ${code}`));
      }
    });

    // Handle spawn errors
    child.on('error', (error: Error) => {
      currentChildProcess = null;
      logger.error(`Failed to spawn worker: ${error.message}`);
      reject(error);
    });

    // Send configuration to worker via stdin
    child.stdin.write(JSON.stringify(config) + '\n');
    child.stdin.end();
  });
}

/**
 * Loads and executes a module to register rollout functions
 */
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
  logger.debug('Received run event');

  const { trace_id, path_to_count, args: rawArgs, overrides } = event.data;

  const parsedArgs = Object.fromEntries(
    Object.entries(rawArgs).map(([key, value]) => {
      if (typeof value === 'string') {
        try {
          return [key, JSON.parse(value)];
        } catch {
          return [key, value];
        }
      }
      return [key, value];
    }),
  ) as Record<string, any>;

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
              parsedInput = typeof span.input === 'string' ? JSON.parse(span.input) : span.input;
            } catch {
              // Keep as string
            }

            try {
              parsedOutput = typeof span.output === 'string'
                ? span.output
                : JSON.stringify(span.output);
            } catch {
              parsedOutput = String(span.output);
            }

            try {
              parsedAttributes = typeof span.attributes === 'string'
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
    const httpPort = options.port ?? (
      baseUrl.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443
    );
    const grpcPort = options.grpcPort ?? 8443;

    // Prepare environment variables for child process
    const env: Record<string, string> = {
      LMNR_ROLLOUT_SESSION_ID: sessionId,
      LMNR_ROLLOUT_STATE_SERVER_ADDRESS: `http://localhost:${cacheServerPort}`,
    };

    // Prepare worker configuration
    const workerConfig: WorkerConfig = {
      filePath,
      functionName,
      args: parsedArgs,
      env,
      cacheServerPort,
      baseUrl,
      projectApiKey: options.projectApiKey,
      httpPort,
      grpcPort,
    };

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

    // Execute the rollout function in child process
    await executeInChildProcess(workerConfig);

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
        // TODO: set to failed, once the API supports it
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
export async function runDev(
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
  const {
    port: cacheServerPort,
    server: cacheServer,
    cache,
    setMetadata,
  } = await startCacheServer();
  logger.debug(`Cache server started on port ${cacheServerPort}`);

  // Build file to discover and select rollout functions
  logger.debug('Discovering rollout functions...');
  let selectedFunction: {
    fn: (...args: any[]) => any; params: any[]; name: string; exportName: string;
  };

  try {
    // FIRST: Extract TypeScript metadata if it's a .ts file
    let paramsMetadata: Map<string, any> | undefined;
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      try {
        paramsMetadata = extractRolloutFunctions(filePath);
        logger.debug(`Extracted TypeScript metadata for ${paramsMetadata.size} functions`);
      } catch (error) {
        logger.warn('Failed to extract TypeScript metadata, falling back to runtime parsing: ' +
          (error instanceof Error ? error.message : String(error)));
      }
    }

    // THEN: Build and load the module
    const moduleText = await buildFile(filePath);
    loadModule({
      filename: filePath,
      moduleText,
    });

    // Select the appropriate function
    selectedFunction = selectRolloutFunction(options.function);

    // If we have TypeScript metadata, use it to enrich the params
    // The TypeScript parser stores functions by their export name (variable name),
    // but runtime registration uses the span name as the key.
    // We need to find the metadata entry where the span name matches.
    if (paramsMetadata) {
      logger.debug(`Available TS metadata keys: ${Array.from(paramsMetadata.keys()).join(', ')}`);
      logger.debug(
        `Looking for span name: ${selectedFunction.name} ` +
        `(runtime key: ${selectedFunction.exportName})`,
      );

      // Search for metadata by span name
      let foundMetadata: any = null;
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

    logger.info(`Serving function: ${selectedFunction.name}`);
    logger.debug(`Function parameters: ${JSON.stringify(selectedFunction.params, null, 2)}`);
  } catch (error: any) {
    logger.error("Failed to discover rollout functions: " +
      (error instanceof Error ? error.message : String(error)));
    throw error;
  }

  // Create SSE client (don't connect yet)
  logger.debug('Setting up SSE client...');
  let sseClient: SSEClient | null = null;

  try {
    sseClient = createSSEClient({
      client,
      sessionId,
      params: selectedFunction.params || [],
      name: selectedFunction.name,
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
        options.function,
      ).catch((error) => {
        // handleRunEvent already logs errors internally, but catch here
        // to prevent unhandled promise rejections
        logger.error('Unhandled error in run event handler: ' +
          (error instanceof Error ? error.message : String(error)));
      });
    });

    sseClient.on('handshake', (event: RolloutHandshakeEvent) => {
      const projectId = event.data.project_id;
      const sessionId = event.data.session_id;
      logger.info(`View your session at https://laminar.sh/project/${projectId}/rollout-sessions/${sessionId}`);
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

      if (currentChildProcess) {
        logger.debug('Terminating child process...');
        currentChildProcess.kill('SIGTERM');

        // Fallback to SIGKILL after 2 seconds
        setTimeout(() => {
          if (currentChildProcess && !currentChildProcess.killed) {
            logger.warn('Child process did not terminate, using SIGKILL');
            currentChildProcess.kill('SIGKILL');
          }
        }, 2000);
      } else {
        logger.debug('No child process running, stop event ignored');
      }
      logger.info('Current run cancelled');
    });

    // Now connect after listeners are registered
    logger.debug('Connecting to backend...');
    logger.debug('Connected to backend. Waiting for run events...');

    // Handle graceful shutdown
    const shutdown = () => {
      // Kill any running child process
      if (currentChildProcess) {
        logger.debug('Terminating child process...');
        currentChildProcess.kill('SIGTERM');
      }

      // Delete the rollout session
      logger.debug('Deleting rollout session...');
      client.rolloutSessions.delete({ sessionId })
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
    // and ensure we can receive signals
    process.stdin.resume();

    // Keep the process running
    await sseClient.connectAndListen();
  } catch (error) {
    logger.error("Failed to start serve command: " +
      (error instanceof Error ? error.message : String(error)));

    // Try to delete the rollout session before exiting
    try {
      await client.rolloutSessions.delete({ sessionId });
    } catch {
      // Ignore delete errors during error cleanup
    }

    cacheServer.close(() => {
      process.exit(1);
    });
  }
}
