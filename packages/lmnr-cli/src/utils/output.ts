import { errorMessage } from '@lmnr-ai/types';

import { pc } from './colors';
import { recordStderr, recordStdout } from './command-capture';

/**
 * stdout data sink: write-through to stdout AND record into the command-capture
 * buffer, so an investigative command's real output lands in its session block.
 * Prefer this (and `printData`) over raw `process.stdout.write` / `console.log`
 * in commands whose output is worth recording.
 */
export function emitData(text: string): void {
  recordStdout(text);
  process.stdout.write(text);
}

/**
 * `console.log`-equivalent that also records into the capture buffer. Writes via
 * `console.log` (NOT the raw `emitData` stream) so it keeps console.log's exact
 * observable behavior — the recording is a parallel side-channel.
 */
export function printData(...args: unknown[]): void {
  recordStdout(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  console.log(...args);
}

/**
 * stderr diagnostics sink for DIRECT (non-logger) writes — e.g. streamed agent
 * activity. Write-through to stderr AND record. Logger output is teed into the
 * same buffer separately (see `utils/logger.ts`), so only raw
 * `process.stderr.write` sites need this.
 */
export function emitErr(text: string): void {
  recordStderr(text);
  process.stderr.write(text);
}

/**
 * Write structured JSON to stdout. Use this for machine-readable output
 * when --json is set. Writes via `console.log` (its long-standing behavior) and
 * records the payload into the capture buffer as a parallel side-channel.
 */
export function outputJson(data: unknown): void {
  const serialized = JSON.stringify(data);
  recordStdout(serialized + '\n');
  console.log(serialized);
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
