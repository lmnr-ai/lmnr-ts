import pino, { Level } from 'pino';
import { PinoPretty } from 'pino-pretty';

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
    PinoPretty({
      colorize,
      minimumLevel: level,
    }),
  );
}
