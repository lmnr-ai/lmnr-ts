import { errorMessage, LaminarSpanContext } from "@lmnr-ai/types";
import { isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";

import {
  deserializeLaminarSpanContext,
  initializeLogger,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
  tryToOtelSpanContext,
} from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { getSpanProcessor } from "../../tracing/index";
import { LaminarSpanProcessor } from "../../tracing/processor";
import { LaminarSpan } from "../../tracing/span";
import { LAMINAR_SPAN_CONTEXT_HEADER, TRACEPARENT_HEADER } from "./consts";

const logger = initializeLogger();
// ─── Payload codec helpers ────────────────────────────────────────────────────
// Temporal headers are `Record<string, Payload>` where Payload is a protobuf
// envelope with `metadata.encoding` and `data` fields.  We avoid importing
// @temporalio/common so that it stays a soft peer-dep.

const _enc = new TextEncoder();
const _dec = new TextDecoder();

export const encodePayload = (value: string): unknown => ({
  metadata: { encoding: _enc.encode("json/plain") },
  data: _enc.encode(JSON.stringify(value)),
});

export const decodePayload = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { data?: Uint8Array | null };
  if (!p.data) return undefined;
  try {
    return JSON.parse(_dec.decode(p.data)) as string;
  } catch {
    return undefined;
  }
};

// ─── Context serialisation ────────────────────────────────────────────────────

/**
 * Read the currently active Laminar span and encode its context into a headers
 * map.  Writes both `laminar-span-context` (full Laminar JSON) and
 * `traceparent` (W3C, for interop with non-Laminar workers).
 *
 * Returns the headers map unchanged if there is no active Laminar span.
 */
export const buildHeaders = (
  existing: Record<string, unknown>,
): Record<string, unknown> => {
  const rawSpan =
    trace.getSpan(LaminarContextManager.getContext()) ?? trace.getActiveSpan();

  if (!rawSpan || !isSpanContextValid(rawSpan.spanContext())) {
    return existing;
  }

  let laminarCtx: LaminarSpanContext | null = null;
  if (rawSpan instanceof LaminarSpan) {
    try {
      laminarCtx = rawSpan.getLaminarSpanContext();
    } catch {
      // fall through to OTel-only path
    }
  }

  const headers: Record<string, unknown> = { ...existing };

  if (laminarCtx) {
    headers[LAMINAR_SPAN_CONTEXT_HEADER] = encodePayload(
      JSON.stringify(laminarCtx),
    );
    const traceHex = laminarCtx.traceId.replace(/-/g, "");
    const spanHex = laminarCtx.spanId.replace(/-/g, "").slice(16);
    headers[TRACEPARENT_HEADER] = encodePayload(`00-${traceHex}-${spanHex}-01`);
  } else {
    const ctx = rawSpan.spanContext();
    headers[TRACEPARENT_HEADER] = encodePayload(
      `00-${ctx.traceId}-${ctx.spanId}-01`,
    );
  }

  return headers;
};

// ─── Context restoration ──────────────────────────────────────────────────────

/**
 * Read `laminar-span-context` (preferred) or `traceparent` (fallback) from
 * Temporal headers and push the restored context onto Laminar's ALS stack.
 *
 * Returns the restored `LaminarSpanContext` or `undefined` if headers contain
 * no usable trace context.
 */
export const restoreContextFromHeaders = (
  headers: Record<string, unknown> | undefined,
): LaminarSpanContext | undefined => {
  if (!headers) return undefined;

  // Preferred: full Laminar context header
  const laminarRaw = decodePayload(headers[LAMINAR_SPAN_CONTEXT_HEADER]);
  if (laminarRaw) {
    try {
      const ctx = deserializeLaminarSpanContext(laminarRaw);
      pushLaminarContext(ctx);
      return ctx;
    } catch (e) {
      logger.warn(
        `[Laminar] Could not restore ${LAMINAR_SPAN_CONTEXT_HEADER}: ${errorMessage(e)}`,
      );
    }
  }

  // Fallback: W3C traceparent
  const traceparent = decodePayload(headers[TRACEPARENT_HEADER]);
  if (traceparent) {
    const parts = traceparent.split("-");
    if (parts.length >= 3) {
      const [, traceHex, spanHex] = parts;
      try {
        const traceId = otelTraceIdToUUID(traceHex);
        const spanId = otelSpanIdToUUID(
          spanHex,
        ) as LaminarSpanContext["spanId"];
        const ctx: LaminarSpanContext = { traceId, spanId, isRemote: true };
        pushLaminarContext(ctx);
        return ctx;
      } catch (e) {
        logger.warn(
          `[Laminar] Could not restore traceparent: ${errorMessage(e)}`,
        );
      }
    }
  }

  return undefined;
};

/** Push a LaminarSpanContext onto the Laminar ALS stack as a remote parent. */
const pushLaminarContext = (laminarCtx: LaminarSpanContext): void => {
  const otelCtx = tryToOtelSpanContext(laminarCtx);
  otelCtx.isRemote = true;

  const processor = getSpanProcessor();
  if (
    processor instanceof LaminarSpanProcessor &&
    laminarCtx.spanPath &&
    laminarCtx.spanIdsPath
  ) {
    processor.setParentPathInfo(
      otelCtx.spanId,
      laminarCtx.spanPath,
      laminarCtx.spanIdsPath,
    );
  }

  // Base the restored parent on ROOT_CONTEXT, NOT `getContext()`. On the worker
  // side an activity has no legitimate ambient parent, and `getContext()` falls
  // back to the process-global active-span stack when the ALS stack is empty —
  // basing on it would let an unrelated worker-thread span's baggage /
  // association properties leak into the restored remote context.
  const base = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(otelCtx));
  const enriched = LaminarContextManager.setRawAssociationProperties(
    laminarCtx,
    base,
  );
  LaminarContextManager.pushContext(enriched);
};
