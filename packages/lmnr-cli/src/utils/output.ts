import { errorMessage } from '@lmnr-ai/types';

/**
 * Write structured JSON to stdout. Use this for machine-readable output
 * when --json is set.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data));
}

/**
 * Write a JSON error to stdout and exit with code 1.
 * Use this in --json mode so agents can parse the failure.
 */
export function outputJsonError(error: unknown, exitCode: number = 1): never {
  console.log(JSON.stringify({
    error: errorMessage(error),
  }));
  process.exit(exitCode);
}
