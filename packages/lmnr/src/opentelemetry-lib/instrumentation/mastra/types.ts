/**
 * Local structural-type shim for the subset of Mastra observability types we
 * actually use. These are intentionally **not** imported from `@mastra/core` or
 * `@mastra/observability`: doing so pulls the full Mastra type graph into our
 * emitted `.d.ts` bundle, which currently ships broken `json-schema` imports
 * via `@mastra/schema-compat` and breaks `tsdown`'s declaration build.
 *
 * We re-declare only the fields our exporter reads. These match the
 * `AnyExportedSpan` contract in `@mastra/core/observability` at the time of
 * writing; since Mastra treats this as a stable export surface for custom
 * exporters, the structural match is safe.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export enum MastraSpanType {
  AGENT_RUN = "agent_run",
  SCORER_RUN = "scorer_run",
  SCORER_STEP = "scorer_step",
  WORKFLOW_RUN = "workflow_run",
  MODEL_GENERATION = "model_generation",
  MODEL_STEP = "model_step",
  MODEL_CHUNK = "model_chunk",
  TOOL_CALL = "tool_call",
  MCP_TOOL_CALL = "mcp_tool_call",
  PROCESSOR_RUN = "processor_run",
  WORKFLOW_STEP = "workflow_step",
  WORKFLOW_CONDITIONAL = "workflow_conditional",
  WORKFLOW_CONDITIONAL_EVAL = "workflow_conditional_eval",
  WORKFLOW_PARALLEL = "workflow_parallel",
  WORKFLOW_LOOP = "workflow_loop",
  WORKFLOW_SLEEP = "workflow_sleep",
  WORKFLOW_WAIT_EVENT = "workflow_wait_event",
  WORKSPACE_ACTION = "workspace_action",
  GENERIC = "generic",
  MEMORY_OPERATION = "memory_operation",
  RAG_INGESTION = "rag_ingestion",
  RAG_EMBEDDING = "rag_embedding",
  RAG_VECTOR_OPERATION = "rag_vector_operation",
  RAG_ACTION = "rag_action",
  GRAPH_ACTION = "graph_action",
}

export enum MastraTracingEventType {
  SPAN_STARTED = "span:started",
  SPAN_UPDATED = "span:updated",
  SPAN_ENDED = "span:ended",
}

export interface MastraUsageStats {
  inputTokens?: number;
  outputTokens?: number;
  inputDetails?: {
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputDetails?: Record<string, any>;
}

export interface MastraModelGenerationAttributes {
  provider?: string;
  model?: string;
  responseModel?: string;
  usage?: MastraUsageStats;
}

export interface MastraExportedSpan {
  id: string;
  traceId: string;
  name: string;
  type: MastraSpanType;
  startTime: Date;
  endTime?: Date;
  attributes?: Record<string, any>;
  metadata?: Record<string, any>;
  tags?: string[];
  input?: any;
  output?: any;
  errorInfo?: {
    message: string;
    details?: Record<string, any> & { stack?: string };
  };
  parentSpanId?: string;
  isRootSpan: boolean;
  isEvent: boolean;
}

export interface MastraTracingEvent {
  type: MastraTracingEventType;
  exportedSpan: MastraExportedSpan;
}
