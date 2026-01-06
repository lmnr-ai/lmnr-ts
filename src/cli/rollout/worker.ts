import * as esbuild from 'esbuild';
import * as readline from 'readline';

import { Laminar } from '../../laminar';
import { getDirname } from '../../utils';

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
      "@lmnr-ai/*",
      "esbuild",
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
  requestedFunctionName?: string,
): { fn: (...args: any[]) => any; params: any[]; name: string } {
  if (!globalThis._rolloutFunctions || globalThis._rolloutFunctions.size === 0) {
    throw new Error(
      "No rollout functions found in file. " +
      " Make sure you are using observe with rolloutEntrypoint: true",
    );
  }

  // If a specific function is requested, use that
  if (requestedFunctionName) {
    const selected = globalThis._rolloutFunctions.get(requestedFunctionName);
    if (!selected) {
      const available = Array.from(globalThis._rolloutFunctions.keys()).join(', ');
      throw new Error(
        `Function '${requestedFunctionName}' not found. Available functions: ${available}`,
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
    `Multiple rollout functions found: ${available}. Use --function to specify which one to serve.`,
  );
}

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
async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let configReceived = false;

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
}

/**
 * Handle graceful shutdown on SIGTERM/SIGINT
 */
async function handleShutdown(signal: string): Promise<void> {
  workerLogger.debug(`Received ${signal}, shutting down gracefully...`);

  try {
    // Shutdown Laminar to flush any pending spans/traces
    if (Laminar.initialized()) {
      await Laminar.shutdown();
      workerLogger.debug('Laminar shutdown complete');
    }
  } catch (error: any) {
    workerLogger.error(`Error during Laminar shutdown: ${error instanceof Error ? error.message : error}`);
  }

  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Start the worker
main().catch((error) => {
  sendMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
