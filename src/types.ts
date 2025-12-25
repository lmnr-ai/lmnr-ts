import { type Datapoint } from "./evaluations";
import { StringUUID } from "./utils";

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

export type Dataset = {
  id: StringUUID;
  name: string;
  createdAt: string;
};

export type PushDatapointsResponse = {
  datasetId: StringUUID;
};

export type EvaluationDatapointDatasetLink = {
  datasetId: StringUUID;
  datapointId: StringUUID;
  createdAt: string;
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
  datasetLink?: EvaluationDatapointDatasetLink;
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
  metadata?: Record<string, any>;
  traceType?: TraceType;
  tracingLevel?: TracingLevel;
};

/**
 * Options for masking different types of input fields during browser session recording.
 */
export interface MaskInputOptions {
  textarea?: boolean;
  text?: boolean;
  number?: boolean;
  select?: boolean;
  email?: boolean;
  tel?: boolean;
}

/**
 * Options for browser session recording configuration.
 */
export interface SessionRecordingOptions {
  maskInputOptions?: MaskInputOptions;
}

/**
 * Event payload for rollout debugging sessions run events
 */
export interface RolloutRunEvent {
  event_type: 'run';
  data: {
    trace_id?: string;
    path_to_count?: Record<string, number>;
    args: Record<string, any>;
    overrides?: Record<string, {
      system?: string;
      tools?: any[];
    }>;
  };
}

export interface RolloutHandshakeEvent {
  event_type: 'handshake';
  data: {
    session_id: string;
    project_id: string;
  };
}

/**
 * Parameter metadata for rollout functions
 *
 * Future fields:
 * - type: string - The TypeScript type of the parameter
 * - required: boolean - Whether the parameter is required
 * - nested: RolloutParam[] - For destructured parameters, contains nested parameter definitions
 */
export interface RolloutParam {
  name: string;
  // Future: type?: string;
  // Future: required?: boolean;
  // Future: nested?: RolloutParam[];
}
