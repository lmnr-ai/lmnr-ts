import { Datapoint } from "./evaluations";
import { StringUUID } from "./utils";

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type NodeInput = ChatMessage[] | string | boolean | number;

export type Event = {
  id: StringUUID;
  templateName: string;
  timestamp: Date;
  spanId: StringUUID;
  value: number | string | null; // number
};

export type InitEvaluationResponse = {
  id: StringUUID,
  createdAt: Date,
  groupId: string,
  name: string,
  projectId: StringUUID,
};

export type EvaluationDatapoint<D, T, O> = {
  id: StringUUID;
  data: D;
  target?: T;
  metadata?: Record<string, any>;
  executorOutput?: O;
  scores?: Record<string, number | null>;
  traceId: string;
  index: number;
  executorSpanId?: string;
};

export type GetDatapointsResponse<D, T> = {
  items: Datapoint<D, T>[];
  totalCount: number;
  anyInProject: boolean;
};

export type SemanticSearchResult = {
  datasetId: StringUUID;
  data: Record<string, any>;
  content: string;
  score: number;
};

export type SemanticSearchResponse = {
  results: SemanticSearchResult[];
};

/**
 * Span types to categorize spans.
 *
 * LLM spans are auto-instrumented LLM spans.
 * Pipeline spans are top-level spans created by the pipeline runner.
 * Executor and evaluator spans are top-level spans added automatically when doing evaluations.
 */
export type SpanType = 'DEFAULT'
  | 'LLM'
  | 'PIPELINE'
  | 'EXECUTOR'
  | 'EVALUATOR'
  | 'HUMAN_EVALUATOR'
  | 'EVALUATION'
  | 'TOOL';


/**
 * Trace types to categorize traces.
 * They are used as association properties passed to all spans in a trace.
 *
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
 */
export type LaminarSpanContext = {
  spanId: StringUUID;
  traceId: StringUUID;
  isRemote: boolean;
};
