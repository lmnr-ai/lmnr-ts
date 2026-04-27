// Narrow structural types for Mastra's observability contract. Declared
// locally to avoid a hard runtime/peer dep on @mastra/core. Also includes
// the slice of AI SDK message shape we serialize into `ai.prompt.messages`.

export type LaminarSpanType = "LLM" | "TOOL" | "DEFAULT";

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
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
  /** Laminar base URL. Defaults to LMNR_BASE_URL env var or https://api.lmnr.ai. */
  baseUrl?: string;
  /** Laminar project API key. Defaults to LMNR_PROJECT_API_KEY. */
  apiKey?: string;
  /** HTTP port of the Laminar API. Defaults to 443. */
  httpPort?: number;
  /** Full OTLP HTTP endpoint override (including /v1/traces). */
  endpoint?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Disable batching (uses SimpleSpanProcessor). */
  disableBatch?: boolean;
  /** Flush immediately after every span end. */
  realtime?: boolean;
  /** Maximum batch size. */
  batchSize?: number;
  /** Trace export timeout (ms). */
  timeoutMillis?: number;
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
