import { errorMessage } from '@lmnr-ai/types';

import { pc } from './colors';

/**
 * Write structured JSON to stdout. Use this for machine-readable output
 * when --json is set.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data));
}

/**
 * Emit a coded error without exiting: `{error, detail}` JSON on stdout in --json
 * mode, otherwise a colored `ERROR (code): detail` line on stderr. Shared error
 * envelope for the interactive device-flow commands (`setup`, `plugin add`),
 * which manage their own exit codes rather than using the with-client wrapper.
 */
export const emitError = (json: boolean, code: string, detail: string): void => {
  if (json) {
    process.stdout.write(JSON.stringify({ error: code, detail }) + '\n');
  } else {
    process.stderr.write(`\n${pc.red(`ERROR (${code})`)}: ${detail}\n`);
  }
};

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
