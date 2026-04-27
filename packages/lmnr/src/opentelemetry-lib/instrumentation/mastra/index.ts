// LaminarMastraExporter is a Mastra `ObservabilityExporter` implementation
// that forwards Mastra AI tracing events into the standard Laminar
// OpenTelemetry pipeline.
//
// Mastra emits its own tracing events (SPAN_STARTED / SPAN_UPDATED /
// SPAN_ENDED) carrying span-type specific attributes. We convert each
// ended span into a minimal OTel `ReadableSpan` and push it through a
// `LaminarSpanExporter`. Crucially, we do NOT go through a Mastra
// BaseExporter; this implementation depends on @mastra/core types only
// (as a peer dependency) and owns the full conversion so we can map
// Laminar-specific span types and attributes directly.
//
// Span-type mapping (lmnr.span.type):
//   MODEL_STEP                → LLM
//   TOOL_CALL / MCP_TOOL_CALL → TOOL
//   MODEL_GENERATION          → DEFAULT (represents the full agent flow)
//   all other Mastra types    → DEFAULT
//   MODEL_CHUNK               → dropped entirely

import {
  type Attributes,
  type HrTime,
  type Link,
  type SpanContext,
  SpanKind,
  type SpanStatus,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import {
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  type TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from "@opentelemetry/semantic-conventions";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger, otelSpanIdToUUID, otelTraceIdToUUID } from "../../../utils";
import { getLangVersion } from "../../../version";
import {
  ASSOCIATION_PROPERTIES,
  LaminarAttributes,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INPUT,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_OUTPUT,
  SPAN_PATH,
  SPAN_SDK_VERSION,
  SPAN_TYPE,
  USER_ID,
} from "../../tracing/attributes";
import { createResource } from "../../tracing/compat";
import { LaminarSpanExporter } from "../../tracing/exporter";

// Minimal structural types for the Mastra observability surface we consume.
// Keeping these local means we don't need @mastra/core installed unless the
// user is already using it. At runtime we only inspect string / object fields,
// so the local shape is safe to rely on.

/** Mastra AI span types, as strings matching `SpanType` in @mastra/core/observability. */
type MastraSpanType =
  | "agent_run"
  | "scorer_run"
  | "scorer_step"
  | "generic"
  | "model_generation"
  | "model_step"
  | "model_chunk"
  | "mcp_tool_call"
  | "processor_run"
  | "tool_call"
  | "workflow_run"
  | "workflow_step"
  | "workflow_conditional"
  | "workflow_conditional_eval"
  | "workflow_parallel"
  | "workflow_loop"
  | "workflow_sleep"
  | "workflow_wait_event"
  | "memory_operation"
  | "workspace_action"
  | "rag_ingestion"
  | "rag_embedding"
  | "rag_vector_operation"
  | "rag_action"
  | "graph_action";

type MastraTracingEventType = "span_started" | "span_updated" | "span_ended";

interface MastraErrorInfo {
  message: string;
  id?: string;
  name?: string;
  stack?: string;
  domain?: string;
  category?: string;
  details?: Record<string, any>;
}

interface MastraExportedSpan {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  type: MastraSpanType;
  startTime: Date | string;
  endTime?: Date | string;
  attributes?: Record<string, any>;
  metadata?: Record<string, any>;
  tags?: string[];
  input?: unknown;
  output?: unknown;
  errorInfo?: MastraErrorInfo;
  isEvent: boolean;
  isRootSpan?: boolean;
}

interface MastraTracingEvent {
  type: MastraTracingEventType;
  exportedSpan: MastraExportedSpan;
}

/** Configuration for {@link LaminarMastraExporter}. */
export interface LaminarMastraExporterConfig {
  /**
   * Laminar project API key. Falls back to the `LMNR_PROJECT_API_KEY`
   * environment variable when not set.
   */
  apiKey?: string;
  /**
   * The base URL of the Laminar API. Defaults to `https://api.lmnr.ai`.
   */
  baseUrl?: string;
  /**
   * The gRPC port of the Laminar API. Defaults to 8443.
   */
  port?: number;
  /**
   * Whether to use HTTP/protobuf instead of gRPC.
   */
  forceHttp?: boolean;
  /**
   * The HTTP port of the Laminar API. Only used when `forceHttp` is true.
   */
  httpPort?: number;
  /**
   * OTLP export timeout in milliseconds. Defaults to 30 seconds.
   */
  timeoutMillis?: number;
  /**
   * Service name reported on the resource attached to every span.
   * Defaults to `mastra-service`.
   */
  serviceName?: string;
  /**
   * Pre-built exporter to use instead of constructing a `LaminarSpanExporter`.
   * Useful for tests.
   */
  exporter?: SpanExporter;
}

interface TraceState {
  spanPathById: Map<string, string[]>;
  spanIdsPathById: Map<string, string[]>;
  activeSpanIds: Set<string>;
}

const MASTRA_ORIGINAL_SPAN_TYPE = "mastra.span.original_type";

/**
 * Laminar exporter for Mastra's AI tracing system.
 *
 * Register it on a Mastra `Observability` instance to forward Mastra AI spans
 * to Laminar:
 *
 * @example
 * ```ts
 * import { Mastra } from '@mastra/core';
 * import { Observability } from '@mastra/observability';
 * import { LaminarMastraExporter } from '@lmnr-ai/lmnr';
 *
 * const mastra = new Mastra({
 *   observability: new Observability({
 *     configs: {
 *       laminar: {
 *         serviceName: 'my-service',
 *         exporters: [new LaminarMastraExporter({ apiKey: '...' })],
 *       },
 *     },
 *   }),
 * });
 * ```
 */
export class LaminarMastraExporter {
  public readonly name = "laminar";

  private readonly logger = initializeLogger();
  private readonly exporter: SpanExporter;
  private readonly processor: SpanProcessor;
  private readonly resource: ReturnType<typeof createResource>;
  private readonly scope = { name: "@lmnr-ai/mastra-exporter", version: SDK_VERSION };
  private readonly traceStates = new Map<string, TraceState>();

  constructor(config: LaminarMastraExporterConfig = {}) {
    const {
      exporter,
      apiKey,
      baseUrl,
      port,
      httpPort,
      forceHttp,
      timeoutMillis,
      serviceName = "mastra-service",
    } = config;

    this.exporter = exporter ?? new LaminarSpanExporter({
      apiKey,
      baseUrl,
      port: forceHttp ? httpPort ?? port : port,
      forceHttp,
      timeoutMillis,
    });
    this.processor = new SimpleSpanProcessor(this.exporter);

    this.resource = createResource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_NAME]: "@lmnr-ai/mastra-exporter",
      [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
    });
  }

  /**
   * Called by Mastra's observability registry when the exporter is registered.
   * No-op for this exporter — all configuration is handled in the constructor.
   */
  init(): void {
    // no-op
  }

  /**
   * Called by Mastra's observability bus for every tracing event.
   */
  exportTracingEvent(event: MastraTracingEvent): Promise<void> {
    try {
      const span = event.exportedSpan;

      // Completely skip streaming chunk events — they are extremely noisy and
      // add no signal that a MODEL_STEP / MODEL_GENERATION span doesn't already
      // carry.
      if (span.type === "model_chunk") {
        return Promise.resolve();
      }

      if (event.type === "span_started" && !span.isEvent) {
        this.recordStart(span);
        return Promise.resolve();
      }

      if (event.type !== "span_ended") {
        return Promise.resolve();
      }

      const readable = this.buildReadableSpan(span);
      if (!readable) {
        return Promise.resolve();
      }
      this.processor.onEnd(readable);

      this.clearTrackedSpan(span);
    } catch (error) {
      this.logger.debug(
        `LaminarMastraExporter failed to handle ${event.type}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return Promise.resolve();
  }

  /**
   * Required by Mastra's `ObservabilityExporter` interface. The base exporter
   * forwards the event to {@link exportTracingEvent}.
   */
  onTracingEvent(event: MastraTracingEvent): Promise<void> {
    return this.exportTracingEvent(event);
  }

  async flush(): Promise<void> {
    await this.processor.forceFlush();
  }

  async shutdown(): Promise<void> {
    try {
      await this.processor.shutdown();
    } finally {
      this.traceStates.clear();
    }
  }

  private recordStart(span: MastraExportedSpan): void {
    const state = this.getOrCreateTraceState(span.traceId);
    const parentPath = span.parentSpanId
      ? state.spanPathById.get(span.parentSpanId)
      : undefined;
    const parentIdsPath = span.parentSpanId
      ? state.spanIdsPathById.get(span.parentSpanId)
      : undefined;

    const spanIdUuid = otelSpanIdToUUID(normalizeSpanId(span.id));
    const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
    const spanIdsPath = parentIdsPath
      ? [...parentIdsPath, spanIdUuid]
      : [spanIdUuid];

    state.spanPathById.set(span.id, spanPath);
    state.spanIdsPathById.set(span.id, spanIdsPath);
    state.activeSpanIds.add(span.id);
  }

  private clearTrackedSpan(span: MastraExportedSpan): void {
    const state = this.traceStates.get(span.traceId);
    if (!state) return;
    state.activeSpanIds.delete(span.id);
    state.spanPathById.delete(span.id);
    state.spanIdsPathById.delete(span.id);
    if (state.activeSpanIds.size === 0) {
      this.traceStates.delete(span.traceId);
    }
  }

  private getOrCreateTraceState(traceId: string): TraceState {
    const existing = this.traceStates.get(traceId);
    if (existing) return existing;
    const created: TraceState = {
      spanPathById: new Map(),
      spanIdsPathById: new Map(),
      activeSpanIds: new Set(),
    };
    this.traceStates.set(traceId, created);
    return created;
  }

  private buildReadableSpan(span: MastraExportedSpan): ReadableSpan | undefined {
    const state = this.getOrCreateTraceState(span.traceId);

    // Event spans and spans we missed at start time still need path data.
    if (!state.spanPathById.has(span.id)) {
      const parentPath = span.parentSpanId
        ? state.spanPathById.get(span.parentSpanId)
        : undefined;
      const parentIdsPath = span.parentSpanId
        ? state.spanIdsPathById.get(span.parentSpanId)
        : undefined;
      const spanIdUuid = otelSpanIdToUUID(normalizeSpanId(span.id));
      state.spanPathById.set(
        span.id,
        parentPath ? [...parentPath, span.name] : [span.name],
      );
      state.spanIdsPathById.set(
        span.id,
        parentIdsPath ? [...parentIdsPath, spanIdUuid] : [spanIdUuid],
      );
    }

    const traceId = normalizeTraceId(span.traceId);
    const spanId = normalizeSpanId(span.id);

    const startTime = dateToHrTime(span.startTime);
    const endTime = span.endTime ? dateToHrTime(span.endTime) : startTime;
    const duration = hrTimeDelta(startTime, endTime);

    const attributes = this.buildAttributes(span, state);
    const { status, events } = buildStatusAndEvents(span, startTime);

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const parentSpanContext: SpanContext | undefined = span.parentSpanId
      ? {
        traceId,
        spanId: normalizeSpanId(span.parentSpanId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      }
      : undefined;

    const links: Link[] = [];

    const readable: ReadableSpan & {
      parentSpanId?: string;
      parentSpanContext?: SpanContext;
      instrumentationLibrary?: unknown;
    } = {
      name: span.name,
      kind: getSpanKind(span.type),
      spanContext: () => spanContext,
      parentSpanId: parentSpanContext?.spanId,
      parentSpanContext,
      startTime,
      endTime,
      status,
      attributes,
      links,
      events,
      duration,
      ended: true,
      resource: this.resource,
      instrumentationScope: this.scope,
      instrumentationLibrary: this.scope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    return readable;
  }

  private buildAttributes(
    span: MastraExportedSpan,
    state: TraceState,
  ): Attributes {
    const attributes: Attributes = {};

    const spanPath = state.spanPathById.get(span.id);
    const spanIdsPath = state.spanIdsPathById.get(span.id);
    if (spanPath) attributes[SPAN_PATH] = spanPath;
    if (spanIdsPath) attributes[SPAN_IDS_PATH] = spanIdsPath;

    attributes[SPAN_TYPE] = mapLaminarSpanType(span.type);
    attributes[MASTRA_ORIGINAL_SPAN_TYPE] = span.type;
    attributes[SPAN_INSTRUMENTATION_SOURCE] = "javascript";
    attributes[SPAN_SDK_VERSION] = SDK_VERSION;
    const langVersion = getLangVersion();
    if (langVersion) {
      attributes[SPAN_LANGUAGE_VERSION] = langVersion;
    }

    // Preferred Laminar inputs/outputs — `lmnr.span.input` / `lmnr.span.output`
    // drive the Laminar chat/JSON view for a span.
    const inputForLaminar = getInputForLaminar(span);
    if (inputForLaminar !== undefined) {
      attributes[SPAN_INPUT] = serializeForLaminar(inputForLaminar);
    }
    if (span.output !== undefined) {
      attributes[SPAN_OUTPUT] = serializeForLaminar(span.output);
    }

    applyMetadataAttributes(attributes, span);

    if (span.isRootSpan && Array.isArray(span.tags) && span.tags.length > 0) {
      attributes[`${ASSOCIATION_PROPERTIES}.tags`] = span.tags.filter(
        (t): t is string => typeof t === "string",
      );
    }

    applyGenAiAttributes(attributes, span);
    applyToolAttributes(attributes, span);

    return attributes;
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure functions)
// ---------------------------------------------------------------------------

const mapLaminarSpanType = (type: MastraSpanType): string => {
  switch (type) {
    case "model_step":
      return "LLM";
    case "tool_call":
    case "mcp_tool_call":
      return "TOOL";
    // MODEL_GENERATION represents the full agent flow, not a single LLM call —
    // keep it DEFAULT so the Laminar UI doesn't treat it as a leaf LLM span.
    default:
      return "DEFAULT";
  }
};

const getSpanKind = (type: MastraSpanType): SpanKind => {
  switch (type) {
    case "model_generation":
    case "model_step":
    case "mcp_tool_call":
      return SpanKind.CLIENT;
    default:
      return SpanKind.INTERNAL;
  }
};

const getInputForLaminar = (span: MastraExportedSpan): unknown => {
  if (span.input === undefined || span.input === null) {
    return span.input;
  }

  // MODEL_GENERATION / MODEL_STEP inputs come in the form `{ messages, ... }`.
  // Pulling the messages array to the top makes the Laminar chat UI render
  // the conversation correctly.
  if (
    (span.type === "model_generation" || span.type === "model_step") &&
    typeof span.input === "object" &&
    !Array.isArray(span.input)
  ) {
    const maybeMessages = (span.input as { messages?: unknown }).messages;
    if (Array.isArray(maybeMessages)) {
      return maybeMessages;
    }
  }

  return span.input;
};

const applyMetadataAttributes = (
  attributes: Attributes,
  span: MastraExportedSpan,
): void => {
  const metadata = span.metadata;
  if (!metadata || typeof metadata !== "object") return;

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;

    if (key === "sessionId" && typeof value === "string") {
      attributes[SESSION_ID] = value;
      continue;
    }
    if (key === "userId" && typeof value === "string") {
      attributes[USER_ID] = value;
      continue;
    }

    const attributeValue = toAttributeValue(value);
    if (attributeValue === undefined) continue;
    attributes[`${ASSOCIATION_PROPERTIES}.metadata.${key}`] = attributeValue;
  }
};

const applyGenAiAttributes = (
  attributes: Attributes,
  span: MastraExportedSpan,
): void => {
  // GenAI attributes only make sense for model spans.
  if (span.type !== "model_generation" && span.type !== "model_step") {
    return;
  }

  const attrs = (span.attributes ?? {}) as {
    model?: string;
    provider?: string;
    responseModel?: string;
    responseId?: string;
    finishReason?: string;
    streaming?: boolean;
    parameters?: {
      maxOutputTokens?: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      presencePenalty?: number;
      frequencyPenalty?: number;
      stopSequences?: string[];
      seed?: number;
    };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      inputDetails?: {
        text?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      outputDetails?: {
        reasoning?: number;
      };
    };
  };

  if (attrs.provider) {
    attributes[LaminarAttributes.PROVIDER] = normalizeProvider(attrs.provider);
  }
  if (attrs.model) {
    attributes[LaminarAttributes.REQUEST_MODEL] = attrs.model;
  }
  if (attrs.responseModel) {
    attributes[LaminarAttributes.RESPONSE_MODEL] = attrs.responseModel;
  } else if (attrs.model) {
    // A common scenario: response model isn't always reported, but the Laminar
    // UI expects it to be present for the span to surface a model badge.
    attributes[LaminarAttributes.RESPONSE_MODEL] = attrs.model;
  }

  if (attrs.responseId) {
    attributes["gen_ai.response.id"] = attrs.responseId;
  }
  if (attrs.finishReason) {
    attributes["gen_ai.response.finish_reason"] = attrs.finishReason;
  }
  if (typeof attrs.streaming === "boolean") {
    attributes["gen_ai.request.streaming"] = attrs.streaming;
  }

  if (attrs.parameters) {
    const p = attrs.parameters;
    if (p.maxOutputTokens !== undefined) {
      attributes["gen_ai.request.max_tokens"] = p.maxOutputTokens;
    }
    if (p.temperature !== undefined) {
      attributes["gen_ai.request.temperature"] = p.temperature;
    }
    if (p.topP !== undefined) {
      attributes["gen_ai.request.top_p"] = p.topP;
    }
    if (p.topK !== undefined) {
      attributes["gen_ai.request.top_k"] = p.topK;
    }
    if (p.presencePenalty !== undefined) {
      attributes["gen_ai.request.presence_penalty"] = p.presencePenalty;
    }
    if (p.frequencyPenalty !== undefined) {
      attributes["gen_ai.request.frequency_penalty"] = p.frequencyPenalty;
    }
    if (p.seed !== undefined) {
      attributes["gen_ai.request.seed"] = p.seed;
    }
    if (Array.isArray(p.stopSequences) && p.stopSequences.length > 0) {
      attributes["gen_ai.request.stop_sequences"] = p.stopSequences;
    }
  }

  const usage = attrs.usage;
  if (usage) {
    if (usage.inputTokens !== undefined) {
      attributes[LaminarAttributes.INPUT_TOKEN_COUNT] = usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      attributes[LaminarAttributes.OUTPUT_TOKEN_COUNT] = usage.outputTokens;
    }
    if (
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined
    ) {
      attributes[LaminarAttributes.TOTAL_TOKEN_COUNT] =
        usage.inputTokens + usage.outputTokens;
    }
    if (usage.inputDetails?.cacheRead !== undefined) {
      attributes["gen_ai.usage.cache_read_input_tokens"] =
        usage.inputDetails.cacheRead;
    }
    if (usage.inputDetails?.cacheWrite !== undefined) {
      attributes["gen_ai.usage.cache_creation_input_tokens"] =
        usage.inputDetails.cacheWrite;
    }
    if (usage.outputDetails?.reasoning !== undefined) {
      attributes["gen_ai.usage.reasoning_tokens"] =
        usage.outputDetails.reasoning;
    }
  }
};

const applyToolAttributes = (
  attributes: Attributes,
  span: MastraExportedSpan,
): void => {
  if (span.type !== "tool_call" && span.type !== "mcp_tool_call") return;

  const attrs = (span.attributes ?? {}) as {
    toolType?: string;
    toolDescription?: string;
    success?: boolean;
    mcpServer?: string;
    serverVersion?: string;
  };

  attributes["gen_ai.tool.name"] = span.name;

  if (attrs.toolType) {
    attributes["gen_ai.tool.type"] = attrs.toolType;
  }
  if (attrs.toolDescription) {
    attributes["gen_ai.tool.description"] = attrs.toolDescription;
  }
  if (typeof attrs.success === "boolean") {
    attributes["gen_ai.tool.success"] = attrs.success;
  }
  if (span.type === "mcp_tool_call") {
    if (attrs.mcpServer) {
      attributes["gen_ai.tool.mcp.server"] = attrs.mcpServer;
    }
    if (attrs.serverVersion) {
      attributes["gen_ai.tool.mcp.server_version"] = attrs.serverVersion;
    }
  }
};

const buildStatusAndEvents = (
  span: MastraExportedSpan,
  defaultTime: HrTime,
): { status: SpanStatus; events: TimedEvent[] } => {
  const events: TimedEvent[] = [];

  if (span.errorInfo) {
    const status: SpanStatus = {
      code: SpanStatusCode.ERROR,
      message: span.errorInfo.message,
    };

    const eventAttributes: Attributes = {
      "exception.message": span.errorInfo.message,
      "exception.type": span.errorInfo.name ?? "Error",
    };
    if (span.errorInfo.stack) {
      eventAttributes["exception.stacktrace"] = span.errorInfo.stack;
    }

    events.push({
      name: "exception",
      attributes: eventAttributes,
      time: defaultTime,
      droppedAttributesCount: 0,
    });

    return { status, events };
  }

  return { status: { code: SpanStatusCode.OK }, events };
};

const dateToHrTime = (date: Date | string): HrTime => {
  const ms = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  const seconds = Math.floor(safeMs / 1000);
  const nanoseconds = (safeMs % 1000) * 1_000_000;
  return [seconds, nanoseconds];
};

const hrTimeDelta = (start: HrTime, end: HrTime): HrTime => {
  // Subtract component-wise with borrow handling. Do NOT collapse to a single
  // nanosecond total — `start[0] * 1e9` overflows Number.MAX_SAFE_INTEGER for
  // current Unix timestamps and loses precision.
  let seconds = end[0] - start[0];
  let nanoseconds = end[1] - start[1];
  if (nanoseconds < 0) {
    seconds -= 1;
    nanoseconds += 1e9;
  }
  if (seconds < 0) {
    return [0, 0];
  }
  return [seconds, nanoseconds];
};

const normalizeTraceId = (traceId: string): string => {
  let id = traceId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  // Some Mastra spans carry UUID-formatted trace ids; strip dashes before padding.
  id = id.replace(/-/g, "");
  if (!/^[0-9a-f]*$/.test(id)) {
    return otelTraceIdToUUID("0".repeat(32)).replace(/-/g, "");
  }
  return id.padStart(32, "0").slice(-32);
};

const normalizeSpanId = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  id = id.replace(/-/g, "");
  if (!/^[0-9a-f]*$/.test(id)) {
    return "0".repeat(16);
  }
  return id.padStart(16, "0").slice(-16);
};

const normalizeProvider = (provider: string): string => {
  const first = provider.split(".").shift();
  return (first ?? provider).toLowerCase().trim();
};

const serializeForLaminar = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const toAttributeValue = (value: unknown): Attributes[string] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const isHomogeneous =
      value.every((v) => typeof v === "string") ||
      value.every((v) => typeof v === "number") ||
      value.every((v) => typeof v === "boolean");
    if (isHomogeneous) return value as Attributes[string];
  }
  return serializeForLaminar(value);
};
