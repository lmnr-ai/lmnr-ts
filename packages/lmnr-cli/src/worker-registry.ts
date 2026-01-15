import * as path from 'path';

export interface WorkerCommand {
  command: string;
  args: string[];
}

/**
 * Default workers mapped by file extension
 */
const DEFAULT_WORKERS: Record<string, WorkerCommand> = {
  '.ts': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.cts': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.mts': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.tsx': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.jsx': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.js': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.mjs': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.cjs': {
    command: 'node',
    args: [], // Will be resolved dynamically
  },
  '.py': {
    command: 'python3',
    args: ['-m', 'lmnr.cli.worker'],
  },
};

/**
 * Get the worker command for a given file path or module.
 * Resolves the TypeScript worker dynamically from @lmnr-ai/lmnr package.
 */
export function getWorkerCommand(
  filePath?: string,
  options?: { pythonModule?: string },
): WorkerCommand {
  // If Python module mode, always use Python worker
  if (options?.pythonModule) {
    return {
      command: 'python3',
      args: ['-m', 'lmnr.cli.worker'],
    };
  }

  // Otherwise determine by file extension
  if (!filePath) {
    throw new Error('Either filePath or pythonModule must be provided');
  }

  const ext = path.extname(filePath);

  if (!DEFAULT_WORKERS[ext]) {
    throw new Error(
      `Unsupported file extension: ${ext}. ` +
      `Supported extensions: ${Object.keys(DEFAULT_WORKERS).join(', ')}`,
    );
  }

  const worker = DEFAULT_WORKERS[ext];

  // For TypeScript/JavaScript files, resolve the worker from @lmnr-ai/lmnr
  if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.jsx'].includes(ext)) {
    try {
      // Try to resolve the worker from @lmnr-ai/lmnr package
      const workerPath = require.resolve('@lmnr-ai/lmnr/dist/cli/worker/index.cjs');
      return {
        command: worker.command,
        args: [workerPath],
      };
    } catch (error) {
      throw new Error(
        'Failed to resolve TypeScript/JavaScript worker from @lmnr-ai/lmnr package. ' +
        'Make sure @lmnr-ai/lmnr is installed. ' +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return worker;
}

/**
 * Get a custom worker command with overrides.
 * Allows users to specify custom commands via CLI flags.
 */
export function getCustomWorkerCommand(
  command: string,
  args: string[],
): WorkerCommand {
  return { command, args };
}
