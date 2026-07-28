import { Writable } from "node:stream";

/**
 * Process-lifetime capture of the current command's stdout / stderr, so
 * `maybeTrackCommand` can record it into a `command` session block. One CLI
 * invocation runs one command, so a process-global buffer IS that command's
 * output — no reset, no cross-command bleed. Fed by the `emitData` / `emitErr`
 * write-through helpers and the pino logger tee; both strip ANSI and stop at a
 * hard cap.
 */

// Most we ship in a block field; matches the frontend renderer's truncation so
// the UI never has to trim what we send.
const MAX_CAPTURE_CHARS = 20_000;

// Buffer up to double the ship cap. The extra 20k is headroom so a large final
// chunk is still captured in full past what we ship, and so exceeding the ship
// cap reliably signals truncation; `append` drops anything beyond this.
const HARD_LIMIT = MAX_CAPTURE_CHARS * 2;

// SGR color/style escapes (from `pc.*` / pino-pretty), stripped so captured
// output is plain text.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_SGR, "");

let stdoutBuf = "";
let stderrBuf = "";

// Slice to remaining headroom BEFORE stripping, so `stripAnsi` never processes
// more than HARD_LIMIT chars for a huge chunk.
const append = (buf: string, chunk: string): string => {
  if (buf.length >= HARD_LIMIT) return buf;
  const room = HARD_LIMIT - buf.length;
  return buf + stripAnsi(chunk.slice(0, room));
};

export const recordStdout = (chunk: string): void => {
  stdoutBuf = append(stdoutBuf, chunk);
};

export const recordStderr = (chunk: string): void => {
  stderrBuf = append(stderrBuf, chunk);
};

// Null when empty (so the field is omitted); otherwise the text, truncated to
// the display cap with a marker.
const finalize = (buf: string): string | null => {
  if (!buf) return null;
  if (buf.length > MAX_CAPTURE_CHARS) {
    return `${buf.slice(0, MAX_CAPTURE_CHARS)}\n… [output truncated]`;
  }
  return buf;
};

export const getCapturedOutput = (): { stdout: string | null; stderr: string | null } => ({
  stdout: finalize(stdoutBuf),
  stderr: finalize(stderrBuf),
});

/**
 * A pino multistream target that tees log records into the shared stderr buffer.
 * We extract `msg` from each NDJSON line so captured stderr reads like the human
 * diagnostics the user saw, falling back to the raw line if there's no string `msg`.
 */
export const createStderrCaptureStream = (): Writable =>
  new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const line = chunk.toString();
      try {
        const record = JSON.parse(line) as { msg?: unknown };
        recordStderr(typeof record.msg === "string" ? `${record.msg}\n` : line);
      } catch {
        recordStderr(line);
      }
      cb();
    },
  });
