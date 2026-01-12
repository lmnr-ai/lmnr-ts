import { StringUUID } from '@lmnr-ai/types';
import { config } from 'dotenv';
import * as path from 'path';
import pino, { Level } from 'pino';
import { PinoPretty } from 'pino-pretty';
import { v4 as uuidv4 } from 'uuid';

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

const logger = initializeLogger();

export const isStringUUID = (id: string): id is StringUUID =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export const NIL_UUID: StringUUID = '00000000-0000-0000-0000-000000000000';

export const newUUID = (): StringUUID => {
  // crypto.randomUUID is available in most of the modern browsers and node,
  // but is not available in "insecure" contexts, e.g. not https, not localhost
  // so we fallback to uuidv4 in those cases, which is less secure, but works
  // just fine.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  } else {
    return uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  }
};

export const otelSpanIdToUUID = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith('0x')) {
    id = id.slice(2);
  }
  if (id.length !== 16) {
    logger.warn(
      `Span ID ${spanId} is not 16 hex chars long. ` +
      'This is not a valid OpenTelemetry span ID.',
    );
  }

  if (!/^[0-9a-f]+$/.test(id)) {
    logger.error(
      `Span ID ${spanId} is not a valid hex string. ` +
      'Generating a random UUID instead.',
    );
    return newUUID();
  }

  return id.padStart(32, '0').replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
    '$1-$2-$3-$4-$5',
  );
};

export const otelTraceIdToUUID = (traceId: string): StringUUID => {
  let id = traceId.toLowerCase();
  if (id.startsWith('0x')) {
    id = id.slice(2);
  }
  if (id.length !== 32) {
    logger.warn(
      `Trace ID ${traceId} is not 32 hex chars long. ` +
      'This is not a valid OpenTelemetry trace ID.',
    );
  }
  if (!/^[0-9a-f]+$/.test(id)) {
    logger.error(
      `Trace ID ${traceId} is not a valid hex string. ` +
      'Generating a random UUID instead.',
    );
    return newUUID();
  }

  return id.replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
    '$1-$2-$3-$4-$5',
  ) as StringUUID;
};

export const slicePayload = <T>(value: T, length: number) => {
  if (value === null || value === undefined) {
    return value;
  }

  const str = JSON.stringify(value);
  if (str.length <= length) {
    return value;
  }

  return str.slice(0, length) + '...';
};

export const loadEnv = (
  options?: {
    quiet?: boolean;
    paths?: string[];
  },
): void => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const envDir = process.cwd();

  // Files to load in order (lowest to highest priority)
  // Later files override earlier ones
  const envFiles = [
    '.env',
    '.env.local',
    `.env.${nodeEnv}`,
    `.env.${nodeEnv}.local`,
  ];

  const logLevel = process.env.LMNR_LOG_LEVEL ?? 'info';
  const verbose = ['debug', 'trace'].includes(logLevel.trim().toLowerCase());

  const quiet = options?.quiet ?? !verbose;

  config({
    path: options?.paths ?? envFiles.map((envFile) => path.resolve(envDir, envFile)),
    quiet,
  });
};
