import { Writable } from "node:stream";

/**
 * Process-lifetime capture of the current command's stdout / stderr, so
 * `maybeTrackCommand` can record what an investigative command produced into
 * its `command` session block.
 *
 * A single CLI invocation runs exactly one command action, so a
 * process-global buffer IS that command's output — there is no per-command
 * reset and no cross-command bleed to worry about. Two sinks feed it: the
 * `emitData` / `emitErr` write-through helpers (direct stdout/stderr writes)
 * and the pino logger tee (`createStderrCaptureStream`). Both strip ANSI so the
 * recorded text is clean, and appends stop at a hard cap so a command that
 * streams megabytes can't grow the buffer without bound.
 */

// The most we ship in a block field. The frontend renderer also truncates at
// this size — keeping the two in step means the UI never has to trim what we
// send. Kept as a plain number (not shared) to avoid a client/types dep here.
const MAX_CAPTURE_CHARS = 20_000;

// Stop appending well past the display cap: we only ever ship MAX_CAPTURE_CHARS,
// so buffering a bit beyond it is enough to know truncation happened, and the
// extra headroom absorbs a final chunk that straddles the boundary.
const HARD_LIMIT = MAX_CAPTURE_CHARS * 2;

// SGR color/style escapes (what `pc.*` and pino-pretty emit). Stripped before
// recording so captured output is plain text, not terminal control codes.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_SGR, "");

let stdoutBuf = "";
let stderrBuf = "";

const append = (buf: string, chunk: string): string =>
  buf.length >= HARD_LIMIT ? buf : buf + stripAnsi(chunk);

export const recordStdout = (chunk: string): void => {
  stdoutBuf = append(stdoutBuf, chunk);
};

export const recordStderr = (chunk: string): void => {
  stderrBuf = append(stderrBuf, chunk);
};

// Null when empty (so the block field is omitted rather than an empty string);
// otherwise the recorded text, truncated to the display cap with a marker.
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
 * A pino multistream target that tees the logger's records into the shared
 * stderr buffer. multistream hands each stream the serialized NDJSON log line;
 * we extract `msg` so the captured stderr reads like the human diagnostics a
 * user saw, not raw JSON (falling back to the raw line if a record has no
 * string `msg` or doesn't parse).
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
