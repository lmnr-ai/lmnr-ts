/**
 * Worker protocol types for subprocess communication between CLI and language-specific workers.
 *
 * The protocol uses stdin/stdout for communication:
 * - Input: JSON configuration sent via stdin (single line)
 * - Output: Protocol messages prefixed with __LMNR_WORKER__: via stdout
 * - User output: Unprefixed stdout (passed through transparently)
 */

/**
 * Configuration sent to worker process via stdin
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
 * Log message from worker to parent
 */
export interface WorkerLogMessage {
  type: 'log';
  level: 'info' | 'debug' | 'error' | 'warn';
  message: string;
}

/**
 * Result message when function completes successfully
 */
export interface WorkerResultMessage {
  type: 'result';
  data: any;
}

/**
 * Error message when function fails
 */
export interface WorkerErrorMessage {
  type: 'error';
  error: string;
  stack?: string;
}

/**
 * Union of all worker message types
 */
export type WorkerMessage =
  | WorkerLogMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

/**
 * Message prefix for protocol messages in stdout
 */
export const WORKER_MESSAGE_PREFIX = '__LMNR_WORKER__:';
