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
 * Laminar representation of an OpenTelemetry span context.
 *
 * spanId - The ID of the span.
 * traceId - The ID of the trace.
 * isRemote - Whether the span is remote.
 * spanPath - The span path (span names) leading to this span.
 * spanIdsPath - The span IDs path leading to this span.
 */
export type LaminarSpanContext = {
  spanId: StringUUID;
  traceId: StringUUID;
  isRemote: boolean;
  spanPath?: string[];
  spanIdsPath?: StringUUID[];
  userId?: string;
  sessionId?: string;
  rolloutSessionId?: string;
  metadata?: Record<string, any>;
  traceType?: TraceType;
  tracingLevel?: TracingLevel;
};

export type Event = {
  id: StringUUID;
  templateName: string;
  timestamp: Date;
  spanId: StringUUID;
  value: number | string | null;
};
