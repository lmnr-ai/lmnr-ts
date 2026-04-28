// Narrow structural types for Mastra's observability contract. Declared
// locally to avoid a hard runtime/peer dep on @mastra/core. Also includes
// the slice of AI SDK message shape we serialize into `ai.prompt.messages`.

export type LaminarSpanType = "LLM" | "TOOL" | "DEFAULT";

// Mirror of the subset of `@mastra/core`'s `SpanType` enum we care about.
// Declared locally so the exporter has no peer dep on Mastra. Mastra may
// emit other span types we don't branch on — `MastraExportedSpan.type` stays
// `string` to keep forward-compat, but every comparison in the exporter
// should use this constant so the set of consumed types is centralized.
//
// Defined as a `const` object (not a TS `enum`) so equality checks against
// `MastraExportedSpan.type: string` don't trip `no-unsafe-enum-comparison`.
export const MastraSpanType = {
  MODEL_GENERATION: "model_generation",
  MODEL_STEP: "model_step",
  MODEL_CHUNK: "model_chunk",
  TOOL_CALL: "tool_call",
  MCP_TOOL_CALL: "mcp_tool_call",
} as const;
export type MastraSpanType =
  (typeof MastraSpanType)[keyof typeof MastraSpanType];

export interface MastraUsageStats {
  inputTokens?: number;
  outputTokens?: number;
  inputDetails?: {
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputDetails?: {
    reasoning?: number;
  };
}

export interface MastraSpanErrorInfo {
  message: string;
  name?: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface MastraExportedSpan {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  type: string;
  startTime: Date;
  endTime?: Date;
  attributes?: Record<string, any>;
  metadata?: Record<string, any>;
  tags?: string[];
  input?: unknown;
  output?: unknown;
  errorInfo?: MastraSpanErrorInfo;
  isEvent: boolean;
  isRootSpan: boolean;
}

export interface MastraTracingEvent {
  type: "span_started" | "span_updated" | "span_ended";
  exportedSpan: MastraExportedSpan;
}

export interface MastraExporterOptions {
  /**
   * Flush the underlying span processor after every span end. Useful for
   * short-lived processes that exit before the batch processor would drain
   * on its own.
   */
  realtime?: boolean;
  /**
   * When true (default), reparent Mastra traces under the caller's active
   * OpenTelemetry span if one exists. This lets `observe()`-wrapped code that
   * calls a Mastra agent produce a single unified trace instead of two
   * disconnected ones (user's OTel trace + Mastra's own trace).
   *
   * Mastra does not propagate OTel context into its event bus, so without
   * this we'd emit under Mastra's self-assigned trace id with no parent.
   * Set to false to preserve Mastra's original trace id even when nested
   * inside `observe()`.
   */
  linkToActiveContext?: boolean;
}

export interface AISdkContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

export interface AISdkMessage {
  role: string;
  content: string | AISdkContentPart[];
  tool_call_id?: string;
}
