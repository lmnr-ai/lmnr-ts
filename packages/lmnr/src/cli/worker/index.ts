import * as readline from 'readline';

import { Laminar } from '../../laminar';
import { consumeStreamResult } from '../../opentelemetry-lib/tracing/stream-utils';
import { buildFile, loadModule, selectRolloutFunction } from './build';

/**
 * Message types sent from child to parent via stdout
 */
interface LogMessage {
  type: 'log';
  level: 'info' | 'debug' | 'error' | 'warn';
  message: string;
}

interface ResultMessage {
  type: 'result';
  data: any;
}

interface ErrorMessage {
  type: 'error';
  error: string;
  stack?: string;
}

type WorkerMessage = LogMessage | ResultMessage | ErrorMessage;

/**
 * Configuration received from parent via stdin
 */
export interface WorkerConfig {
  filePath: string;
  functionName?: string;
  args: Record<string, any> | any[];
  env: Record<string, string>;
  cacheServerPort: number;
  baseUrl: string;
  projectApiKey?: string;
  httpPort: number;
  grpcPort: number;
  externalPackages?: string[];
  dynamicImportsToSkip?: string[];
}

/**
 * Prefix for worker protocol messages to distinguish from user console.log output
 */
const WORKER_MESSAGE_PREFIX = '__LMNR_WORKER__:';

/**
 * Sends a message to parent process via stdout.
 * Returns a Promise that resolves only once the data has been handed off to the
 * OS pipe buffer (via the write callback). This must be awaited before any
 * process.exit() call so that large messages are not truncated when Node.js
 * discards its internal stream buffers on exit.
 */
const sendMessage = (message: WorkerMessage): Promise<void> => {
  return new Promise((resolve) => {
    process.stdout.write(WORKER_MESSAGE_PREFIX + JSON.stringify(message) + '\n', () => resolve());
  });
}

/**
 * Logger that sends log messages to parent.
 * These are fire-and-forget: since stream writes are FIFO, awaiting the final
 * sendMessage (result/error) before exit is sufficient to flush all prior logs.
 */
const workerLogger = {
  info: async (message: string) => { await sendMessage({ type: 'log', level: 'info', message }); },
  debug: async (message: string) => { await sendMessage({ type: 'log', level: 'debug', message }); },
  error: async (message: string) => { await sendMessage({ type: 'log', level: 'error', message }); },
  warn: async (message: string) => { await sendMessage({ type: 'log', level: 'warn', message }); },
};

/**
 * Main worker execution function
 * Returns the result of the rollout function or throws an error
 */
async function runWorker(config: WorkerConfig): Promise<any> {
  // Set environment variables
  for (const [key, value] of Object.entries(config.env)) {
    process.env[key] = value;
  }

  await workerLogger.debug('Building user file...');
  const moduleText = await buildFile(config.filePath, {
    externalPackages: config.externalPackages,
    dynamicImportsToSkip: config.dynamicImportsToSkip,
  });

  await workerLogger.debug('Loading user file...');
  loadModule({
    filename: config.filePath,
    moduleText,
  });

  // Select the appropriate rollout function
  const selectedFunction = selectRolloutFunction(config.functionName);
  await workerLogger.debug(`Selected function: ${selectedFunction.name}`);

  // Initialize Laminar
  const urlWithoutSlash = config.baseUrl.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
  const baseHttpUrl = `${urlWithoutSlash}:${config.httpPort}`;

  if (!Laminar.initialized()) {
    workerLogger.debug('Initializing Laminar...');
    Laminar.initialize({
      projectApiKey: config.projectApiKey,
      baseUrl: config.baseUrl,
      baseHttpUrl,
      httpPort: config.httpPort,
      grpcPort: config.grpcPort,
      disableBatch: true,
    });
  }

  // Execute the rollout function with args
  workerLogger.debug('Executing rollout function...');

  const orderedArgs = Array.isArray(config.args)
    ? config.args
    : selectedFunction.params.map(param => {
      // Handle destructured parameters by reconstructing the object from nested properties
      if (param.nested && param.nested.length > 0) {
        const reconstructed: Record<string, any> = {};
        for (const nestedParam of param.nested) {
          reconstructed[nestedParam.name] = (config.args as Record<string, any>)[nestedParam.name];
        }
        return reconstructed;
      }
      // Regular parameter
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (config.args as Record<string, any>)[param.name];
    });
  await workerLogger.info(
    `Calling function ${selectedFunction.name} with args: ${JSON.stringify(orderedArgs)}`,
  );

  const rawResult = await selectedFunction.fn(...orderedArgs);

  // Consume the result if it's a stream to ensure background processing completes
  await workerLogger.debug('Consuming result (if stream)...');
  const result = await consumeStreamResult(rawResult);

  await workerLogger.info('Rollout function completed successfully');

  return result;
}

/**
 * Read configuration from stdin and start worker
 * Centralized exit point for the worker process
 */
const main = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let configReceived = false;

  // This function is called anyway, so it can be async.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  rl.on('line', async (line: string) => {
    if (configReceived) {
      return;
    }

    try {
      const config: WorkerConfig = JSON.parse(line);
      configReceived = true;
      rl.close();

      // Execute the worker and handle result/errors
      try {
        const result = await runWorker(config);
        if (Laminar.initialized()) {
          await Laminar.flush();
        }

        // Send result back to parent and wait for the write to flush before
        // exiting, otherwise process.exit() discards buffered stream data.
        await sendMessage({ type: 'result', data: result });
        process.exit(0);
      } catch (error: any) {
        await workerLogger.error(`Error in worker: ${error instanceof Error ? error.message : error}`);

        if (Laminar.initialized()) {
          await Laminar.flush();
        }

        await sendMessage({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        process.exit(1);
      }
    } catch (error: any) {
      await sendMessage({
        type: 'error',
        error: `Failed to parse config: ${error instanceof Error ? error.message : error}`,
      });
      process.exit(1);
    }
  });

  rl.on('close', () => {
    if (!configReceived) {
      void sendMessage({
        type: 'error',
        error: 'No configuration received on stdin',
      }).then(() => process.exit(1));
    }
  });
};

/**
 * Handle graceful shutdown on SIGTERM/SIGINT
 */
const handleShutdown = () => {
  if (Laminar.initialized()) {
    Laminar.shutdown().catch((error: any) => {
      workerLogger.error(
        `Error during Laminar shutdown: ${error instanceof Error ? error.message : error}`,
      ).catch(() => { });
    }).finally(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

// Register signal handlers
process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

// Start the worker
try {
  main();
} catch (error: any) {
  void sendMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }).then(() => process.exit(1));
}
