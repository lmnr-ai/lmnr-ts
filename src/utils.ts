import { AttributeValue, SpanContext, TraceFlags } from '@opentelemetry/api';
import path from "path";
import pino, { Level } from 'pino';
import pinoPretty from 'pino-pretty';
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from 'uuid';

import { LaminarSpanContext } from './types';
import { ASSOCIATION_PROPERTIES } from './opentelemetry-lib/tracing/attributes';

export function initializeLogger(options?: { colorize?: boolean, level?: Level }) {
  const colorize = options?.colorize ?? true;
  const level = options?.level
    ?? (process.env.LMNR_LOG_LEVEL?.toLowerCase()?.trim() as Level)
    ?? 'info';

  return pino(pinoPretty({
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
    '$1-$2-$3-$4-$5'
  );
};

export const otelTraceIdToUUID = (traceId: string): string => {
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
    '$1-$2-$3-$4-$5'
  );
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
  if (typeof record.spanId === 'string' && typeof record.traceId === 'string') {
    return {
      spanId: uuidToOtelSpanId(record?.spanId ?? record?.['span_id']),
      traceId: uuidToOtelTraceId(record?.traceId ?? record?.['trace_id']),
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

export const metadataToAttributes = (metadata: Record<string, unknown>): Record<string, AttributeValue> => {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (isOtelAttributeValueType(value)) {
        return [`${ASSOCIATION_PROPERTIES}.metadata.${key}`, value];
      } else {
        return [`${ASSOCIATION_PROPERTIES}.metadata.${key}`, JSON.stringify(value)];
      }
    }),
  );
};
