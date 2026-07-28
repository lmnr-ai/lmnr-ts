import pino, { Level } from 'pino';
import { PinoPretty } from 'pino-pretty';

import { createStderrCaptureStream } from './command-capture';

// Shared logger tee: one capture stream for the whole process, so every
// `initializeLogger()` instance records into the SAME command-capture buffer.
// Created once at module scope (a fresh stream per logger would each hold their
// own state and only the last would be observed). Diagnostics still render to
// stderr (fd 2) exactly as before; this only forks a copy into the buffer that
// `maybeTrackCommand` reads.
const captureStream = createStderrCaptureStream();

export function initializeLogger(options?: { colorize?: boolean; level?: Level }) {
  const colorize = options?.colorize ?? true;
  const level =
    options?.level ??
    (process.env.LMNR_LOG_LEVEL?.toLowerCase()?.trim() as Level) ??
    'info';

  return pino(
    {
      level,
    },
    pino.multistream([
      { level, stream: PinoPretty({ colorize, minimumLevel: level, destination: 2 }) },
      { level, stream: captureStream },
    ]),
  );
}
