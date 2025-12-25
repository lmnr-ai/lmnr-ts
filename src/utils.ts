import { AttributeValue, SpanContext, TraceFlags } from '@opentelemetry/api';
import * as path from "path";
import pino, { Level } from 'pino';
import { PinoPretty } from 'pino-pretty';
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from 'uuid';

import { ASSOCIATION_PROPERTIES } from './opentelemetry-lib/tracing/attributes';
import { LaminarSpanContext, TraceType, TracingLevel } from './types';

export function initializeLogger(options?: { colorize?: boolean, level?: Level }) {
  const colorize = options?.colorize ?? true;
  const level = options?.level
    ?? (process.env.LMNR_LOG_LEVEL?.toLowerCase()?.trim() as Level)
    ?? 'info';

  return pino(PinoPretty({
    colorize,
    minimumLevel: level,
  }));
}

const logger = initializeLogger();

export type StringUUID = `${string}-${string}-${string}-${string}-${string}`;

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
    logger.warn(`Span ID ${spanId} is not 16 hex chars long. ` +
      'This is not a valid OpenTelemetry span ID.');
  }

  if (!/^[0-9a-f]+$/.test(id)) {
    logger.error(`Span ID ${spanId} is not a valid hex string. ` +
      'Generating a random UUID instead.');
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
    logger.warn(`Trace ID ${traceId} is not 32 hex chars long. ` +
      'This is not a valid OpenTelemetry trace ID.');
  }
  if (!/^[0-9a-f]+$/.test(id)) {
    logger.error(`Trace ID ${traceId} is not a valid hex string. ` +
      'Generating a random UUID instead.');
    return newUUID();
  }

  return id.replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
    '$1-$2-$3-$4-$5',
  ) as StringUUID;
};

export const uuidToOtelTraceId = (uuid: string): string => uuid.replace(/-/g, '');
export const uuidToOtelSpanId = (uuid: string): string => uuid.replace(/-/g, '').slice(16);

/**
 * This is a simple implementation of a semaphore to replicate
 * the behavior of the `asyncio.Semaphore` in Python.
 */
export class Semaphore {
  /**
   * Number of permits available.
   */
  private _value: number;
  /**
   * List of promises that will be resolved when a permit becomes available.
   */
  private _waiters: ((...args: any[]) => any)[] = [];

  constructor(value = 1) {
    if (value < 0) {
      throw new Error("Semaphore value must be >= 0");
    }
    this._value = value;
    this._waiters = [];
  }

  async acquire() {
    if (this._value > 0) {
      this._value--;
      return;
    }

    // Create a promise that will be resolved when a permit becomes available
    return new Promise(resolve => {
      this._waiters.push(resolve);
    });
  }

  release() {
    if (this._waiters.length > 0) {
      // If there are waiters, wake up the first one
      const resolve = this._waiters.shift();
      resolve?.();
    } else {
      this._value++;
    }
  }

  // Python-like context manager functionality
  async using<T>(fn: (...args: any[]) => Promise<T>) {
    try {
      await this.acquire();
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const tryToOtelSpanContext = (
  spanContext: LaminarSpanContext | Record<string, unknown> | string | SpanContext,
): SpanContext => {
  if (typeof spanContext === 'string') {
    try {
      const record = JSON.parse(spanContext) as Record<string, unknown>;
      return recordToOtelSpanContext(record);
    } catch (e) {
      throw new Error(`Failed to parse span context ${spanContext}. ` +
        'The string must be a json representation of a LaminarSpanContext.'
        + `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (isRecord(spanContext)) {
    // This covers the `LaminarSpanContext` case too.
    return recordToOtelSpanContext(spanContext);
  } else if (typeof spanContext.traceId === 'string'
    && typeof spanContext.spanId === 'string'
    && spanContext.traceId.length === 32
    && spanContext.spanId.length === 16) {
    logger.warn('The span context is already an OpenTelemetry SpanContext. ' +
      'Returning it as is. Please use `LaminarSpanContext` objects instead.');
    return spanContext;
  }
  else {
    throw new Error(`Invalid span context ${JSON.stringify(spanContext)}. ` +
      'Must be a LaminarSpanContext or its json representation.');
  }
};

const recordToOtelSpanContext = (record: Record<string, unknown>): SpanContext => {
  if ((typeof record.spanId === 'string' && typeof record.traceId === 'string') ||
    (typeof record.span_id === 'string' && typeof record.trace_id === 'string')) {
    return {
      spanId: uuidToOtelSpanId(record?.spanId as string ?? record?.['span_id'] as string),
      traceId: uuidToOtelTraceId(record?.traceId as string ?? record?.['trace_id'] as string),
      isRemote: record?.isRemote ?? record?.['is_remote'] ?? false,
      traceFlags: record?.traceFlags ?? TraceFlags.SAMPLED,
    } as SpanContext;
  } else {
    throw new Error(`Invalid span context ${JSON.stringify(record)}. ` +
      'Must be a json representation of a LaminarSpanContext.');
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && !Array.isArray(value) && value !== null;

/**
 * Deserialize a LaminarSpanContext from a string or record.
 * Handles both camelCase and snake_case keys for cross-language compatibility.
 *
 * @param data - The data to deserialize (string or record)
 * @returns The deserialized LaminarSpanContext
 * @throws Error if the data is invalid
 */
export const deserializeLaminarSpanContext = (
  data: Record<string, unknown> | string,
): LaminarSpanContext => {
  if (typeof data === 'string') {
    try {
      const record = JSON.parse(data) as Record<string, unknown>;
      return deserializeLaminarSpanContext(record);
    } catch (e) {
      throw new Error(
        `Failed to parse LaminarSpanContext: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (!isRecord(data)) {
    throw new Error('Invalid LaminarSpanContext: must be a string or object');
  }

  // Handle both camelCase and snake_case for all fields
  const traceId = data.traceId ?? data.trace_id;
  const spanId = data.spanId ?? data.span_id;
  const isRemote = data.isRemote ?? data.is_remote ?? false;
  const spanPath = data.spanPath ?? data.span_path;
  const spanIdsPath = data.spanIdsPath ?? data.span_ids_path;
  const userId = data.userId ?? data.user_id;
  const sessionId = data.sessionId ?? data.session_id;
  const metadata = data.metadata;
  const traceType = data.traceType ?? data.trace_type;
  const tracingLevel = data.tracingLevel ?? data.tracing_level;

  if (typeof traceId !== 'string' || typeof spanId !== 'string') {
    throw new Error('Invalid LaminarSpanContext: traceId and spanId must be strings');
  }

  // Validate UUID format
  if (!isStringUUID(traceId) || !isStringUUID(spanId)) {
    throw new Error('Invalid LaminarSpanContext: traceId and spanId must be valid UUIDs');
  }

  return {
    traceId: traceId,
    spanId: spanId,
    isRemote: Boolean(isRemote),
    spanPath: Array.isArray(spanPath) ? spanPath as string[] : undefined,
    spanIdsPath: Array.isArray(spanIdsPath) ? spanIdsPath as StringUUID[] : undefined,
    userId: userId as string | undefined,
    sessionId: sessionId as string | undefined,
    metadata: metadata as Record<string, unknown> | undefined,
    traceType: traceType as TraceType | undefined,
    tracingLevel: tracingLevel as TracingLevel | undefined,
  };
};


export const getDirname = () => {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }

  if (typeof import.meta?.url !== 'undefined') {
    return path.dirname(fileURLToPath(import.meta.url));
  }

  return process.cwd();
};

export const slicePayload = <T>(value: T, length: number) => {
  if (value === null || value === undefined) {
    return value;
  }

  const str = JSON.stringify(value);
  if (str.length <= length) {
    return value;
  }

  return (str.slice(0, length) + '...');
};

export const isOtelAttributeValueType = (value: unknown): value is AttributeValue => {
  if (typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    const allStrings = value.every(value => (value == null) || typeof value === 'string');
    const allNumbers = value.every(value => (value == null) || typeof value === 'number');
    const allBooleans = value.every(value => (value == null) || typeof value === 'boolean');
    return allStrings || allNumbers || allBooleans;
  }
  return false;
};

export const metadataToAttributes = (
  metadata: Record<string, unknown>,
): Record<string, AttributeValue> => Object.fromEntries(
  Object.entries(metadata).map(([key, value]) => {
    if (isOtelAttributeValueType(value)) {
      return [`${ASSOCIATION_PROPERTIES}.metadata.${key}`, value];
    } else {
      return [`${ASSOCIATION_PROPERTIES}.metadata.${key}`, JSON.stringify(value)];
    }
  }),
);

/**
 * Get OTEL environment variable with priority order.
 * Checks in order:
 * 1. OTEL_EXPORTER_OTLP_TRACES_{varName}
 * 2. OTEL_EXPORTER_OTLP_{varName}
 * 3. OTEL_{varName}
 *
 * @param varName - The variable name (e.g., 'ENDPOINT', 'HEADERS', 'PROTOCOL')
 * @returns The environment variable value or undefined if not found
 */
export const getOtelEnvVar = (varName: string): string | undefined => {
  const candidates = [
    `OTEL_EXPORTER_OTLP_TRACES_${varName}`,
    `OTEL_EXPORTER_OTLP_${varName}`,
    `OTEL_${varName}`,
  ];

  for (const candidate of candidates) {
    const value = process?.env?.[candidate];
    if (value) {
      return value;
    }
  }
  return undefined;
};

/**
 * Check if OTEL configuration is available.
 * @returns true if OTEL endpoint is configured
 */
export const hasOtelConfig = (): boolean => !!getOtelEnvVar('ENDPOINT');

/**
 * Parse OTEL headers string into a record object.
 * Format: key1=value1,key2=value2
 * Values are URL-decoded.
 *
 * @param headersStr - Headers string in OTEL format
 * @returns Parsed headers object
 */
export const parseOtelHeaders = (headersStr: string | undefined): Record<string, string> => {
  if (!headersStr) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const pair of headersStr.split(',')) {
    const equalIndex = pair.indexOf('=');
    if (equalIndex !== -1) {
      // Manually split instead of .split('=', 2) because
      // the latter only returns the first 2 elements of the array after the split
      const key = pair.substring(0, equalIndex).trim();
      const value = pair.substring(equalIndex + 1).trim();
      headers[key] = decodeURIComponent(value);
    }
  }
  return headers;
};

/**
 * Validate that either Laminar API key or OTEL configuration is present.
 * Throws an error if neither is configured.
 *
 * @param apiKey - The Laminar API key (if provided)
 * @throws Error if neither API key nor OTEL configuration is present
 */
export const validateTracingConfig = (apiKey?: string): void => {
  if (!apiKey && !hasOtelConfig()) {
    throw new Error(
      'Please initialize the Laminar object with your project API key ' +
      'or set the LMNR_PROJECT_API_KEY environment variable, ' +
      'or configure OTEL environment variables (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, etc.)',
    );
  }
};
