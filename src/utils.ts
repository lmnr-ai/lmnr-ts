import { v4 as uuidv4 } from 'uuid';

export type StringUUID = `${string}-${string}-${string}-${string}-${string}`;

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

export function isNumber(value: unknown): value is number {
    return typeof value === 'number';
}
