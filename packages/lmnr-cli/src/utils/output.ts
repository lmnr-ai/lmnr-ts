import { errorMessage } from "@lmnr-ai/types";

import { pc } from "./colors";
import { recordStderr, recordStdout } from "./command-capture";

/**
 * stdout data sink: write-through to stdout AND record into the capture buffer.
 * Prefer this (and `printData`) over raw `process.stdout.write` / `console.log`
 * in commands whose output is worth recording.
 */
export function emitData(text: string): void {
  recordStdout(text);
  process.stdout.write(text);
}

/**
 * `console.log`-equivalent that also records into the capture buffer. Writes via
 * `console.log` to keep its exact behavior; recording is a parallel side-channel.
 */
export function printData(...args: unknown[]): void {
  recordStdout(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n",
  );
  console.log(...args);
}

/**
 * stderr diagnostics sink for DIRECT (non-logger) writes — e.g. streamed agent
 * activity. Write-through to stderr AND record. Logger output is teed separately,
 * so only raw `process.stderr.write` sites need this.
 */
export function emitErr(text: string): void {
  recordStderr(text);
  process.stderr.write(text);
}

/**
 * Write structured JSON to stdout for machine-readable `--json` output. Writes
 * via `console.log` and records the payload as a parallel side-channel.
 */
export function outputJson(data: unknown): void {
  const serialized = JSON.stringify(data);
  recordStdout(serialized + "\n");
  console.log(serialized);
}

/**
 * Emit a coded error without exiting: `{error, detail}` JSON on stdout in --json
 * mode, else a colored `ERROR (code): detail` on stderr. Used by the interactive
 * device-flow commands (`setup`, `plugin add`) that manage their own exit codes.
 */
export const emitError = (
  json: boolean,
  code: string,
  detail: string,
): void => {
  if (json) {
    process.stdout.write(JSON.stringify({ error: code, detail }) + "\n");
  } else {
    process.stderr.write(`\n${pc.red(`ERROR (${code})`)}: ${detail}\n`);
  }
};

/**
 * Write a JSON error to stdout and exit with code 1.
 * Use this in --json mode so agents can parse the failure.
 */
export function outputJsonError(error: unknown, exitCode: number = 1): never {
  console.log(
    JSON.stringify({
      error: errorMessage(error),
    }),
  );
  process.exit(exitCode);
}
