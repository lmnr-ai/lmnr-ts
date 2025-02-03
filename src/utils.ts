import { v4 as uuidv4 } from 'uuid';

export type StringUUID = `${string}-${string}-${string}-${string}-${string}`;

export const isStringUUID = (id: string): id is StringUUID => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

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
}

export const otelSpanIdToUUID = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith('0x')) {
    id = id.slice(2);
  }
  if (id.length !== 16) {
    console.warn(`Span ID ${spanId} is not 16 hex chars long. This is not a valid OpenTelemetry span ID.`);
  }

  if (!/^[0-9a-f]+$/.test(id)) {
    console.error(`Span ID ${spanId} is not a valid hex string. Generating a random UUID instead.`);
    return newUUID();
  }

  return id.padStart(32, '0').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export const otelTraceIdToUUID = (traceId: string): string => {
  let id = traceId.toLowerCase();
  if (id.startsWith('0x')) {
    id = id.slice(2);
  }
  if (id.length !== 32) {
    console.warn(`Trace ID ${traceId} is not 32 hex chars long. This is not a valid OpenTelemetry trace ID.`);
  }
  if (!/^[0-9a-f]+$/.test(id)) {
    console.error(`Trace ID ${traceId} is not a valid hex string. Generating a random UUID instead.`);
    return newUUID();
  }

  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export const uuidToOtelTraceId = (uuid: string): string => {
  return uuid.replace(/-/g, '');
}

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
  async using(fn: (...args: any[]) => any) {
      try {
          await this.acquire();
          return await fn();
      } finally {
          this.release();
      }
  }
}
