import * as readline from 'readline';

import { Laminar } from '../../laminar';
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
interface WorkerConfig {
  filePath: string;
  functionName?: string;
  args: Record<string, any>;
  env: Record<string, string>;
  cacheServerPort: number;
  baseUrl: string;
  projectApiKey: string;
  httpPort: number;
  grpcPort: number;
}

/**
 * Prefix for worker protocol messages to distinguish from user console.log output
 */
const WORKER_MESSAGE_PREFIX = '__LMNR_WORKER__:';

/**
 * Sends a message to parent process via stdout
 * Uses a special prefix to distinguish from user's console.log output
 */
function sendMessage(message: WorkerMessage): void {
  console.log(WORKER_MESSAGE_PREFIX + JSON.stringify(message));
}

/**
 * Logger that sends log messages to parent
 */
const workerLogger = {
  info: (message: string) => sendMessage({ type: 'log', level: 'info', message }),
  debug: (message: string) => sendMessage({ type: 'log', level: 'debug', message }),
  error: (message: string) => sendMessage({ type: 'log', level: 'error', message }),
  warn: (message: string) => sendMessage({ type: 'log', level: 'warn', message }),
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

  workerLogger.debug('Building user file...');
  const moduleText = await buildFile(config.filePath);

  workerLogger.debug('Loading user file...');
  loadModule({
    filename: config.filePath,
    moduleText,
  });

  // Select the appropriate rollout function
  const selectedFunction = selectRolloutFunction(config.functionName);
  workerLogger.info(`Selected function: ${selectedFunction.name}`);

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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  const orderedArgs = selectedFunction.params.map(param => config.args[param.name]);
  workerLogger.info(`Calling function with args: ${JSON.stringify(orderedArgs)}`);

  const result = await selectedFunction.fn(...orderedArgs);

  workerLogger.info('Rollout function completed successfully');
  workerLogger.debug(`Result: ${JSON.stringify(result, null, 2)}`);

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

        // Send result back to parent
        sendMessage({ type: 'result', data: result });

        // Exit successfully
        process.exit(0);
      } catch (error: any) {


        workerLogger.error(`Error in worker: ${error instanceof Error ? error.message : error}`);

        sendMessage({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        if (Laminar.initialized()) {
          await Laminar.flush();
        }

        // Exit with error code
        process.exit(1);
      }
    } catch (error: any) {
      sendMessage({
        type: 'error',
        error: `Failed to parse config: ${error instanceof Error ? error.message : error}`,
      });
      process.exit(1);
    }
  });

  rl.on('close', () => {
    if (!configReceived) {
      sendMessage({
        type: 'error',
        error: 'No configuration received on stdin',
      });
      process.exit(1);
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
      );
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
  sendMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
}
