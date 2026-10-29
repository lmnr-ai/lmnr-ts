import pino, { Level } from "pino";
import { PinoPretty } from "pino-pretty";

// Own logger, so the pure layer doesn't import `utils.ts` (which pulls in the
// tracing attributes and OTel). Same configuration as `initializeLogger`.
const level =
  (process.env.LMNR_LOG_LEVEL?.toLowerCase()?.trim() as Level) ?? "info";

export const logger = pino(
  { level },
  PinoPretty({ colorize: true, minimumLevel: level }),
);
