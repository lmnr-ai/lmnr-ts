// Type-only: the canonical Laminar span-type vocabulary. Imported as a type so
// it is erased at runtime (jiti strips it) — this keeps the sandbox upload path
// free of any @lmnr-ai/types dependency while locking our span types to the SDK.
import type { SpanType } from "@lmnr-ai/types";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { type ExportResult,ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { EXPORT_TIMEOUT_S, type LaminarConfig } from "./config.js";
import { debug, info } from "./logger.js";
import type { Json } from "./types.js";
import { jsonDumpsTruncated } from "./util.js";

// Laminar span-attribute keys (reused verbatim from the CC plugin's conventions).
export const SPAN_TYPE_ATTR = "lmnr.span.type";
export const SPAN_INPUT_ATTR = "lmnr.span.input";
export const SPAN_OUTPUT_ATTR = "lmnr.span.output";
export const SPAN_PATH_ATTR = "lmnr.span.path";
export const ASSOC_PREFIX = "lmnr.association.properties";
// Metadata key the Laminar backend keys debugger (rollout) sessions on. Stamped
// on every span of a debug run so the trace shows up in the debugger session.
export const ROLLOUT_SESSION_META = `${ASSOC_PREFIX}.metadata.rollout.session_id`;
// Association-property attribute that classifies the trace (DEFAULT | EVALUATION).
// Propagated from the injected span context onto every span so harbor-driven
// eval trials are recorded as EVALUATION traces — matching the Laminar SDK,
// which reads/writes this exact key.
export const TRACE_TYPE_ATTR = `${ASSOC_PREFIX}.trace_type`;

/** Parsed form of the injected `LMNR_SPAN_CONTEXT`: the OTel remote-parent
 * context to nest under, plus the Laminar trace classification to propagate.
 * Mirrors the SDK's `LaminarSpanContext`, which carries `trace_type` alongside
 * the ids. `null` when the env var is absent/unparseable. */
export interface InjectedSpanContext {
  context: Context;
  /** DEFAULT | EVALUATION | null — stamped onto this run's spans so the backend
   * classifies the trace like the SDK does (harbor eval trials → EVALUATION). */
  traceType: string | null;
}

/**
 * Parse the serialized Laminar span context Harbor injects via `LMNR_SPAN_CONTEXT`
 * to link the agent's trace to its EXECUTOR span. Returns null when
 * absent/unparseable — the run then roots its own trace as before (fail-open).
 *
 * Format mirrors the Laminar SDK (`LaminarSpanContext.model_dump_json`): JSON
 * with `trace_id`/`span_id` as UUID strings, where the SDK packs the OTel ids
 * via `uuid.UUID(int=<otel_id>)`. So trace_id's 32 hex ARE the OTel 128-bit
 * trace id, and span_id's LOW 64 bits (last 16 hex) are the OTel 8-byte span id.
 * `trace_type` travels in the same JSON and is carried through verbatim.
 */
export function parseInjectedSpanContext(
  raw: string | undefined | null,
): InjectedSpanContext | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const traceRaw = (obj.trace_id ?? obj.traceId) as string | undefined;
    const spanRaw = (obj.span_id ?? obj.spanId) as string | undefined;
    if (typeof traceRaw !== "string" || typeof spanRaw !== "string") {
      return null;
    }
    const traceId = traceRaw.replace(/-/g, "").toLowerCase();
    // span_id is a UUID whose low 64 bits carry the OTel 8-byte span id.
    const spanId = spanRaw.replace(/-/g, "").toLowerCase().slice(-16);
    if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
      return null;
    }
    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    const traceTypeRaw = obj.trace_type ?? obj.traceType;
    return {
      context: trace.setSpanContext(ROOT_CONTEXT, spanContext),
      traceType: typeof traceTypeRaw === "string" ? traceTypeRaw : null,
    };
  } catch {
    return null;
  }
}

/** Back-compat helper: just the OTel remote-parent `Context` (or null). */
export function remoteParentContextFromEnv(raw: string | undefined | null): Context | null {
  return parseInjectedSpanContext(raw)?.context ?? null;
}

/** Convert loosely-typed attributes to OTel attributes, dropping unsupported values. */
function toOtelAttributes(attrs: Record<string, Json>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const arr = value.filter((x) => x !== null && x !== undefined);
      out[key] = arr as AttributeValue;
      continue;
    }
    // Objects and other types are unsupported as attribute values — drop them.
  }
  return out;
}

/** Collects finished spans in memory so we can export them together. */
class CollectingSpanProcessor implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Owns the OTel provider + collecting processor and mints spans. */
export class TraceEmitter {
  readonly config: LaminarConfig;
  private readonly processor: CollectingSpanProcessor;
  private readonly tracer;
  // Attributes stamped on every span this emitter mints (e.g. the debugger
  // rollout-session association). Empty on the common, non-debug path.
  private readonly defaultAttributes: Record<string, Json>;
  // Context that root spans (parent === null) attach to. ROOT_CONTEXT for a
  // standalone trace; an injected remote parent (LMNR_SPAN_CONTEXT) when this
  // run should nest under an upstream span (e.g. Harbor's EXECUTOR).
  private readonly rootParent: Context;

  constructor(
    config: LaminarConfig,
    defaultAttributes: Record<string, Json> = {},
    rootParent: Context | null = null,
  ) {
    this.config = config;
    this.defaultAttributes = defaultAttributes;
    this.rootParent = rootParent ?? ROOT_CONTEXT;
    this.processor = new CollectingSpanProcessor();
    const provider = new BasicTracerProvider({
      resource: new Resource({
        "service.name": "pi",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.name": "lmnr-pi-extension",
      }),
      spanProcessors: [this.processor],
    });
    this.tracer = provider.getTracer("lmnr.pi");
  }

  get spans(): ReadableSpan[] {
    return this.processor.spans;
  }

  /** Remove already-exported spans so each export ships only new ones. */
  drainSpans(): ReadableSpan[] {
    return this.processor.spans.splice(0, this.processor.spans.length);
  }

  startSpan(
    name: string,
    startTime: Date,
    attributes: Record<string, Json>,
    parent: SpanHandle | null,
  ): SpanHandle {
    const parentCtx = parent ? parent.context : this.rootParent;
    const merged = { ...this.defaultAttributes, ...attributes };
    const span = this.tracer.startSpan(
      name,
      { kind: SpanKind.INTERNAL, startTime, attributes: toOtelAttributes(merged) },
      parentCtx,
    );
    span.setStatus({ code: SpanStatusCode.OK });
    return new SpanHandle(span, startTime);
  }
}

/** A mutable span under construction; end() finalizes it into the emitter. */
export class SpanHandle {
  readonly context: Context;
  private readonly span: Span;
  private readonly startTime: Date;
  private ended = false;

  constructor(span: Span, startTime: Date) {
    this.span = span;
    this.startTime = startTime;
    this.context = trace.setSpan(ROOT_CONTEXT, span);
  }

  get traceId(): string {
    return this.span.spanContext().traceId;
  }

  get spanId(): string {
    return this.span.spanContext().spanId;
  }

  setAttributes(attributes: Record<string, Json>): void {
    this.span.setAttributes(toOtelAttributes(attributes));
  }

  /** Mark the span errored (e.g. a tool result with isError). */
  setError(message?: string): void {
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  end(endTime: Date | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    let end = endTime ?? this.startTime;
    if (end.getTime() < this.startTime.getTime()) {
      end = this.startTime;
    }
    this.span.end(end);
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

export interface StartSpanArgs {
  name: string;
  parent: SpanHandle | null;
  startTime: Date | null;
  spanType?: SpanType;
  inputValue?: Json;
  attributes?: Record<string, Json>;
}

/** Mint a span with the Laminar span-type + optional JSON input attribute. */
export function startSpan(emitter: TraceEmitter, args: StartSpanArgs): SpanHandle {
  const attrs: Record<string, Json> = { [SPAN_TYPE_ATTR]: args.spanType ?? "DEFAULT" };
  if (args.inputValue !== undefined && args.inputValue !== null) {
    // Truncate here so every span input honors LMNR_MAX_CHARS (ticket 5).
    attrs[SPAN_INPUT_ATTR] = jsonDumpsTruncated(args.inputValue);
  }
  if (args.attributes) {
    Object.assign(attrs, args.attributes);
  }
  return emitter.startSpan(args.name, args.startTime ?? new Date(), attrs, args.parent);
}

/**
 * Idempotently register (upsert) a debugger rollout session with the backend so
 * it exists in the UI and collects traces stamped with its id. Mirrors the SDK's
 * `POST /v1/rollouts/{sessionId}`. Fail-open: never throws.
 */
export async function registerRolloutSession(
  config: LaminarConfig,
  sessionId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/rollouts/${sessionId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(Math.round(EXPORT_TIMEOUT_S * 1000)),
    });
    if (!res.ok) {
      info(`rollout session register failed: HTTP ${res.status}`);
      return false;
    }
    debug(`registered debugger rollout session ${sessionId}`);
    return true;
  } catch (e) {
    info(`rollout session register error (swallowed): ${String(e)}`);
    return false;
  }
}

/** Export the given finished spans in one OTLP/HTTP/JSON request; true on 2xx. */
async function exportSpans(emitter: TraceEmitter, spans: ReadableSpan[]): Promise<boolean> {
  if (spans.length === 0) {
    return true;
  }
  const exporter = new OTLPTraceExporter({
    url: `${emitter.config.baseUrl}/v1/traces`,
    headers: { Authorization: `Bearer ${emitter.config.apiKey}` },
    timeoutMillis: Math.round(EXPORT_TIMEOUT_S * 1000),
  });
  try {
    const result = await new Promise<ExportResult>((resolve) => {
      exporter.export(spans, resolve);
    });
    if (result.code === ExportResultCode.SUCCESS) {
      debug(`OTLP export: ${spans.length} span(s)`);
      return true;
    }
    info(`OTLP export failed: ${result.error ?? "unknown error"}`);
    return false;
  } catch (e) {
    info(`OTLP export failed: ${String(e)}`);
    return false;
  } finally {
    try {
      await exporter.shutdown();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

/**
 * Export the emitter's undrained spans, capped by a hard timeout so a hung
 * connection can't stall pi. Fail-open: never throws, returns false on error.
 */
export async function exportWithTimeout(emitter: TraceEmitter): Promise<boolean> {
  const spans = emitter.drainSpans();
  if (spans.length === 0) {
    return true;
  }
  const timeoutMs = Math.round((EXPORT_TIMEOUT_S + 1) * 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([exportSpans(emitter, spans), timeout]);
  } catch (e) {
    info(`export error (swallowed): ${String(e)}`);
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
