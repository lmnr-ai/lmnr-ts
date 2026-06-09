import { type StringUUID } from "./utils";

/**
 * Span types to categorize spans.
 *
 * LLM spans are auto-instrumented LLM spans.
 * Pipeline spans are top-level spans created by the pipeline runner.
 * Executor and evaluator spans are top-level spans added automatically when doing evaluations.
 */
export type SpanType =
  | 'DEFAULT'
  | 'LLM'
  | 'EXECUTOR'
  | 'EVALUATOR'
  | 'HUMAN_EVALUATOR'
  | 'EVALUATION'
  | 'TOOL'
  | 'CACHED';

/**
 * Trace types to categorize traces.
 * They are used as association properties passed to all spans in a trace.
 */
export type TraceType = 'DEFAULT' | 'EVALUATION';

/**
 * Tracing levels to conditionally disable tracing.
 *
 * OFF - No tracing is sent.
 * META_ONLY - Only metadata is sent (e.g. tokens, costs, etc.).
 * ALL - All data is sent.
 */
export enum TracingLevel {
  OFF = 'off',
  META_ONLY = 'meta_only',
  ALL = 'all',
}

/**
 * Debugger context propagated as ONE nested block of a LaminarSpanContext.
 *
 * Carries the debug-replay v2 coordinates a downstream run needs to consult the
 * same server-side cache window as the run that produced this context. Laminar
 * is the only producer; a hand-forged or `enabled: false` block is treated as
 * absent by the consumer (behaviour is explicitly undefined).
 *
 * enabled - armed flag — only `true` blocks are ever constructed by us.
 * sessionId - the run's session id, a hyphenated UUID (undefined when absent).
 * replayTraceId - the source trace to replay, a hyphenated UUID (undefined when
 *   absent).
 * cacheUntil - the cache-window span-id needle, kept VERBATIM (hyphenated or
 *   not, full UUID or short suffix) — the server resolves it.
 */
export type DebugContext = {
  enabled: boolean;
  sessionId?: string;
  replayTraceId?: string;
  cacheUntil?: string;
};

/**
 * Laminar representation of an OpenTelemetry span context.
 *
 * spanId - The ID of the span.
 * traceId - The ID of the trace.
 * isRemote - Whether the span is remote.
 * spanPath - The span path (span names) leading to this span.
 * spanIdsPath - The span IDs path leading to this span.
 * debug - Propagated debugger context, if any (debug-replay v2).
 */
export type LaminarSpanContext = {
  spanId: StringUUID;
  traceId: StringUUID;
  isRemote: boolean;
  spanPath?: string[];
  spanIdsPath?: StringUUID[];
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  traceType?: TraceType;
  tracingLevel?: TracingLevel;
  debug?: DebugContext;
};

export type Event = {
  id: StringUUID;
  templateName: string;
  timestamp: Date;
  spanId: StringUUID;
  value: number | string | null;
};
