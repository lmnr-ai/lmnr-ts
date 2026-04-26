import {
  HrTime,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { OTLPTraceExporter as ExporterHttp } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanProcessor,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from "@opentelemetry/semantic-conventions";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger, otelSpanIdToUUID } from "../../../utils";
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
import { createResource, makeSpanOtelV2Compatible } from "../../tracing/compat";

const logger = initializeLogger();

type LaminarSpanType = "LLM" | "TOOL" | "DEFAULT";

// Narrow structural types for Mastra's observability contract. Declared
// locally to avoid a hard runtime/peer dep on @mastra/core.
interface MastraUsageStats {
  inputTokens?: number;
  outputTokens?: number;
  inputDetails?: {
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface MastraSpanErrorInfo {
  message: string;
  name?: string;
  stack?: string;
  details?: Record<string, unknown>;
}

interface MastraExportedSpan {
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

interface MastraTracingEvent {
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

interface TraceState {
  spanPathById: Map<string, string[]>;
  spanIdsPathById: Map<string, string[]>;
  activeSpanIds: Set<string>;
  // When the first event for this Mastra trace arrived inside an active OTel
  // span (e.g. a user's `observe()` wrapper), we rewrite outgoing spans onto
  // that OTel trace so the whole thing renders as a single trace. Stored
  // once, at first-event time, and reused for every span in the trace.
  otelTraceId?: string;
  otelRootParentSpanId?: string;
  // Outer span's SPAN_PATH / SPAN_IDS_PATH, captured from the active
  // LaminarSpan's attributes at first-event time. Prepended to every Mastra
  // span's path so Laminar's UI (which builds its hierarchy from
  // `lmnr.span.ids_path`, NOT OTel parent-span relationships) renders the
  // Mastra subtree nested under the outer `observe()` span rather than as a
  // sibling on the same trace.
  otelParentSpanPath?: string[];
  otelParentSpanIdsPath?: string[];
}

interface ToolCallChild {
  // Tool-call identifier extracted from the tool_call span (attributes/input)
  // when available. Used to pair results with the step's declared toolCalls
  // by id — necessary when tools execute in parallel and finish out of
  // declaration order. Falls back to arrival-order pairing when absent.
  toolCallId?: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

interface GenerationState {
  // Messages as originally passed into the generation (system + user).
  baseMessages: AISdkMessage[];
  // Per-step conversation turn (assistant message + tool-result messages).
  // Assembled at step-end, keyed by stepIndex so we can replay history for
  // step N as [baseMessages, ...turns in order].
  turnsByStepIndex: Map<number, AISdkMessage[]>;
  // Ordered tool_call children per step — collected as they end (always
  // before their parent MODEL_STEP ends) so we can pair them by arrival
  // order with the step's declared `toolCalls` when the step itself ends.
  toolCallChildrenByStepIndex: Map<number, ToolCallChild[]>;
  // Lookup: tool_call span id → step index, set when the child span starts.
  toolCallSpanIdToStepIndex: Map<string, number>;
}

interface AISdkContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

interface AISdkMessage {
  role: string;
  content: string | AISdkContentPart[];
  tool_call_id?: string;
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

const normalizeTraceId = (traceId: string): string => {
  let id = traceId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  return id.padStart(32, "0").slice(-32);
};

const normalizeSpanId = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  return id.padStart(16, "0").slice(-16);
};

const dateToHrTime = (date: Date): HrTime => {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1e3);
  const nanoseconds = (ms % 1e3) * 1e6;
  return [seconds, nanoseconds];
};

const computeDuration = (start: Date, end?: Date): HrTime => {
  if (!end) return [0, 0];
  // Clamp to 0 on negative diffs: duration is semantically non-negative, and
  // OTel's HrTime contract requires a non-negative nanosecond component that
  // Math.floor + `%` don't preserve when diffMs < 0 (clock skew, reordered
  // Mastra timestamps).
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  return [Math.floor(diffMs / 1e3), (diffMs % 1e3) * 1e6];
};

const normalizeProvider = (provider: string): string =>
  provider.split(".").shift()?.toLowerCase().trim() ||
  provider.toLowerCase().trim();

// `model_step` is Laminar's atomic LLM call. `model_generation` wraps the
// whole agent-to-LLM flow (which may include multiple steps + tool calls),
// so it stays DEFAULT.
const mapLaminarSpanType = (spanType: string): LaminarSpanType => {
  switch (spanType) {
    case "model_step":
      return "LLM";
    case "tool_call":
    case "mcp_tool_call":
      return "TOOL";
    default:
      return "DEFAULT";
  }
};

const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

type AttrPrimitive = string | number | boolean;
const toAttributeValue = (
  value: unknown,
): AttrPrimitive | AttrPrimitive[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value;
    if (value.every((v) => typeof v === "number")) return value;
    if (value.every((v) => typeof v === "boolean")) return value;
  }
  return serializeJSON(value);
};

const extractMessages = (input: unknown): unknown[] | undefined => {
  if (!input) return undefined;
  if (Array.isArray(input)) return input as unknown[];
  if (typeof input === "object") {
    const asObj = input as Record<string, unknown>;
    if (Array.isArray(asObj.messages)) return asObj.messages as unknown[];
    if (Array.isArray(asObj.prompt)) return asObj.prompt as unknown[];
    if (Array.isArray(asObj.input)) return asObj.input as unknown[];
  }
  return undefined;
};

// Mastra's content can be a string, or an array of parts like
// `{type: "text", text: "..."}` — or the odd AI-SDK-internal shape where
// tool calls appear as empty user messages. Strip provider-specific extras
// and pass through structured parts, dropping empty placeholder content.
const normalizeContent = (content: unknown): string | AISdkContentPart[] => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: AISdkContentPart[] = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "text";
      if (type === "text") {
        const text = typeof obj.text === "string" ? obj.text : "";
        if (text.length > 0) parts.push({ type: "text", text });
      } else if (type === "tool-call" || type === "tool_call") {
        parts.push({
          type: "tool-call",
          toolCallId:
            (obj.toolCallId as string | undefined) ??
            (obj.id as string | undefined),
          toolName:
            (obj.toolName as string | undefined) ??
            (obj.name as string | undefined),
          input: obj.input ?? obj.args ?? obj.arguments,
        });
      } else if (type === "tool-result" || type === "tool_result") {
        parts.push({
          type: "tool-result",
          toolCallId: obj.toolCallId as string | undefined,
          toolName: obj.toolName as string | undefined,
          output: obj.output ?? obj.result,
        });
      } else {
        // Unknown part — preserve serialized text so we don't silently drop it.
        const serialized = serializeJSON(p);
        if (serialized !== "{}" && serialized !== "null") {
          parts.push({ type: "text", text: serialized });
        }
      }
    }
    return parts;
  }
  return serializeJSON(content);
};

const normalizeInputMessages = (raw: unknown[]): AISdkMessage[] => {
  const out: AISdkMessage[] = [];
  for (const m of raw) {
    // Drop null/undefined items — same rationale as the empty-user-message
    // filter below (no signal, and they'd otherwise leak through as empty
    // user messages in `ai.prompt.messages`).
    if (m == null) continue;
    if (typeof m === "string") {
      out.push({ role: "user", content: m });
      continue;
    }
    if (typeof m === "number" || typeof m === "boolean") {
      out.push({ role: "user", content: String(m) });
      continue;
    }
    if (typeof m !== "object") {
      out.push({ role: "user", content: serializeJSON(m) });
      continue;
    }
    const obj = m as Record<string, unknown>;
    const role = typeof obj.role === "string" ? obj.role : "user";
    const content = normalizeContent(obj.content);
    // Drop empty user-message placeholders Mastra emits between steps — they
    // carry no signal (tool results appear as separate tool-role messages).
    if (
      role === "user" &&
      ((typeof content === "string" && content.length === 0) ||
        (Array.isArray(content) && content.length === 0))
    ) {
      continue;
    }
    const tool_call_id =
      typeof obj.tool_call_id === "string" ? obj.tool_call_id : undefined;
    out.push({ role, content, tool_call_id });
  }
  return out;
};

const buildAssistantMessageFromStepOutput = (
  output: unknown,
): AISdkMessage | null => {
  if (!output || typeof output !== "object") return null;
  const outObj = output as Record<string, unknown>;
  const parts: AISdkContentPart[] = [];
  if (typeof outObj.text === "string" && outObj.text.length > 0) {
    parts.push({ type: "text", text: outObj.text });
  }
  if (Array.isArray(outObj.toolCalls)) {
    for (const tc of outObj.toolCalls as Array<Record<string, unknown>>) {
      if (!tc) continue;
      parts.push({
        type: "tool-call",
        toolCallId:
          (tc.toolCallId as string | undefined) ??
          (tc.id as string | undefined),
        toolName:
          (tc.toolName as string | undefined) ??
          (tc.name as string | undefined),
        input: tc.input ?? tc.args ?? tc.arguments,
      });
    }
  }
  if (parts.length === 0) return null;
  return { role: "assistant", content: parts };
};

// Pull the tool-call id from a tool_call span. Mastra typically surfaces it
// via `attributes.toolCallId`, but some builds attach it to the input payload
// instead — check both so we can pair by id regardless.
const extractToolCallId = (span: MastraExportedSpan): string | undefined => {
  const attrs = span.attributes;
  if (attrs && typeof attrs.toolCallId === "string") return attrs.toolCallId;
  const input = span.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const asObj = input as Record<string, unknown>;
    if (typeof asObj.toolCallId === "string") return asObj.toolCallId;
    if (typeof asObj.id === "string") return asObj.id;
  }
  return undefined;
};

const formatUsage = (usage?: MastraUsageStats): Record<string, number> => {
  if (!usage) return {};
  const out: Record<string, number> = {};
  if (typeof usage.inputTokens === "number") {
    out[LaminarAttributes.INPUT_TOKEN_COUNT] = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    out[LaminarAttributes.OUTPUT_TOKEN_COUNT] = usage.outputTokens;
  }
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total > 0) {
    out[LaminarAttributes.TOTAL_TOKEN_COUNT] = total;
  }
  if (typeof usage.inputDetails?.cacheWrite === "number") {
    out["gen_ai.usage.cache_creation_input_tokens"] =
      usage.inputDetails.cacheWrite;
  }
  if (typeof usage.inputDetails?.cacheRead === "number") {
    out["gen_ai.usage.cache_read_input_tokens"] = usage.inputDetails.cacheRead;
  }
  return out;
};

/**
 * Bridges Mastra's ObservabilityExporter contract to Laminar's OTLP ingestion.
 *
 * Span-type mapping:
 * - `model_step` → LLM (atomic LLM call; rendered with message history).
 * - `tool_call`, `mcp_tool_call` → TOOL.
 * - `model_chunk` → dropped (per-delta, noise).
 * - everything else → DEFAULT.
 *
 * Tool-call reconstruction: Mastra's `extractStepInput` collapses prior tool
 * calls/results into empty user messages on MODEL_STEP inputs, so we
 * reconstruct the full conversation by accumulating (baseMessages → step0's
 * assistant message → tool-result message(s) → step1's assistant message →
 * …) using the parent MODEL_GENERATION's input and the children TOOL_CALL
 * spans paired by arrival order with each step's declared toolCalls.
 *
 * For LLM spans we emit `ai.prompt.messages` (stringified AI SDK messages
 * with tool-call / tool-result content parts) and `ai.response.text` +
 * `ai.response.toolCalls` so Laminar's backend parser threads them into
 * the LLM message history view.
 */
export class MastraExporter {
  public readonly name = "laminar";

  private readonly config: {
    apiKey: string;
    endpoint: string;
    headers: Record<string, string>;
    realtime: boolean;
    disableBatch: boolean;
    batchSize: number;
    timeoutMillis: number;
    linkToActiveContext: boolean;
  } | null;

  private processor?: SpanProcessor;
  private otlpExporter?: ExporterHttp;
  private resource?: unknown;
  private readonly scope = { name: "@lmnr-ai/lmnr", version: SDK_VERSION };
  private isSetup = false;

  private readonly traceMap: Map<string, TraceState> = new Map();
  private readonly generationStateById: Map<string, GenerationState> =
    new Map();
  private readonly generationAttrsById: Map<string, Record<string, unknown>> =
    new Map();
  private readonly generationIdByStepId: Map<string, string> = new Map();
  // Remember step index per step span so tool_call children can look up which
  // step they belong to (fan-in by arrival order).
  private readonly stepIndexBySpanId: Map<string, number> = new Map();

  constructor(options: MastraExporterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.LMNR_PROJECT_API_KEY;
    if (!apiKey) {
      logger.warn(
        "[MastraExporter] LMNR_PROJECT_API_KEY is not set and no apiKey " +
          "was passed — exporter will drop all spans.",
      );
      this.config = null;
      return;
    }

    const baseUrl = stripTrailingSlash(
      options.baseUrl ?? process.env.LMNR_BASE_URL ?? "https://api.lmnr.ai",
    );
    const port = options.httpPort ?? 443;
    const defaultEndpoint = /:\d+$/.test(baseUrl)
      ? `${baseUrl}/v1/traces`
      : `${baseUrl}:${port}/v1/traces`;

    this.config = {
      apiKey,
      endpoint: options.endpoint ?? defaultEndpoint,
      headers: {
        ...(options.headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
      },
      realtime: options.realtime ?? false,
      disableBatch: options.disableBatch ?? false,
      batchSize: options.batchSize ?? 512,
      timeoutMillis: options.timeoutMillis ?? 30000,
      linkToActiveContext: options.linkToActiveContext ?? true,
    };
  }

  init(options?: { config?: { serviceName?: string } }): void {
    const serviceName = options?.config?.serviceName ?? "mastra-service";
    this.resource = createResource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_NAME]: "@lmnr-ai/lmnr",
      [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
    });
  }

  async exportTracingEvent(event: MastraTracingEvent): Promise<void> {
    // Fully short-circuit when the exporter is misconfigured (no API key).
    // Without this guard, handleSpanStarted and generationAttrsById would
    // accumulate state indefinitely while handleSpanEnded's early-return
    // skips the cleanup block that reclaims it.
    if (!this.config) return;

    const span = event.exportedSpan;
    // Point-in-time event spans have no start/end pair and don't map cleanly
    // onto our span-tree model — drop them regardless of phase. The guard must
    // cover span_ended too: otherwise an isEvent span arriving on that phase
    // slips through to handleSpanEnded and gets exported as a real span.
    if (span.isEvent) return;

    // Always remember generation attributes so children can resolve them
    // regardless of event ordering. Merge (not overwrite) so a span_updated
    // event carrying only a delta (e.g. just `usage`) can't clobber keys
    // set earlier at span_started (e.g. `provider`, `model`). MODEL_STEP
    // children end before MODEL_GENERATION's span_ended restores the full
    // set, so applyLlmAttributes would otherwise read a partial snapshot.
    if (span.type === "model_generation" && span.attributes) {
      const existing = this.generationAttrsById.get(span.id);
      this.generationAttrsById.set(
        span.id,
        existing ? { ...existing, ...span.attributes } : span.attributes,
      );
    }

    if (event.type === "span_started") {
      this.handleSpanStarted(span);
      return;
    }
    if (event.type !== "span_ended") return;
    await this.handleSpanEnded(span);
  }

  async onTracingEvent(event: MastraTracingEvent): Promise<void> {
    await this.exportTracingEvent(event);
  }

  async flush(): Promise<void> {
    if (!this.processor) return;
    try {
      await this.processor.forceFlush();
    } catch (err) {
      logger.error(
        `[MastraExporter] forceFlush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.processor?.shutdown();
    } finally {
      this.processor = undefined;
      this.otlpExporter = undefined;
      this.isSetup = false;
      this.traceMap.clear();
      this.generationStateById.clear();
      this.generationAttrsById.clear();
      this.generationIdByStepId.clear();
      this.stepIndexBySpanId.clear();
    }
  }

  private handleSpanStarted(span: MastraExportedSpan): void {
    if (span.type === "model_chunk") return;

    const traceState = this.getOrCreateTraceState(span.traceId);
    const parentId = span.parentSpanId;

    // For Mastra roots (no Mastra parent) we seed from the captured outer
    // observe() path so Laminar's UI nests the subtree underneath. For
    // Mastra descendants we use the parent Mastra span's stored path, which
    // already has the outer path prepended.
    const parentPath = parentId
      ? traceState.spanPathById.get(parentId)
      : traceState.otelParentSpanPath;
    const parentIdsPath = parentId
      ? traceState.spanIdsPathById.get(parentId)
      : traceState.otelParentSpanIdsPath;

    const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
    const spanIdsPath = parentIdsPath
      ? [...parentIdsPath, otelSpanIdToUUID(span.id)]
      : [otelSpanIdToUUID(span.id)];

    traceState.spanPathById.set(span.id, spanPath);
    traceState.spanIdsPathById.set(span.id, spanIdsPath);
    traceState.activeSpanIds.add(span.id);

    if (span.type === "model_generation") {
      this.initGenerationState(span);
    } else if (span.type === "model_step" && parentId) {
      this.generationIdByStepId.set(span.id, parentId);
      const stepIndex =
        typeof span.attributes?.stepIndex === "number"
          ? span.attributes.stepIndex
          : 0;
      this.stepIndexBySpanId.set(span.id, stepIndex);
    } else if (
      (span.type === "tool_call" || span.type === "mcp_tool_call") &&
      parentId
    ) {
      // Parent is a MODEL_STEP → this tool_call belongs to that step.
      const stepIndex = this.stepIndexBySpanId.get(parentId);
      const generationId = this.generationIdByStepId.get(parentId);
      if (stepIndex !== undefined && generationId !== undefined) {
        const gen = this.generationStateById.get(generationId);
        if (gen) {
          gen.toolCallSpanIdToStepIndex.set(span.id, stepIndex);
        }
      }
    }
  }

  private async handleSpanEnded(span: MastraExportedSpan): Promise<void> {
    if (!this.config) return;
    if (span.type === "model_chunk") return;

    this.setupIfNeeded();
    if (!this.processor) return;

    const traceState = this.getOrCreateTraceState(span.traceId);

    try {
      // Backfill path info when SPAN_STARTED was missed (e.g. exporter
      // registered mid-trace or a re-entrant span_ended without a matching
      // span_started). Inside the try so a throw here still runs cleanup.
      if (!traceState.spanPathById.has(span.id)) {
        const parentId = span.parentSpanId;
        const parentPath = parentId
          ? traceState.spanPathById.get(parentId)
          : traceState.otelParentSpanPath;
        const parentIdsPath = parentId
          ? traceState.spanIdsPathById.get(parentId)
          : traceState.otelParentSpanIdsPath;
        const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
        const spanIdsPath = parentIdsPath
          ? [...parentIdsPath, otelSpanIdToUUID(span.id)]
          : [otelSpanIdToUUID(span.id)];
        traceState.spanPathById.set(span.id, spanPath);
        traceState.spanIdsPathById.set(span.id, spanIdsPath);
      }

      if (span.type === "model_generation") {
        const existing = this.generationStateById.get(span.id);
        if (!existing) {
          this.initGenerationState(span);
        } else if (existing.baseMessages.length === 0) {
          // span_started may have carried an empty/incomplete input; refresh
          // baseMessages from span_ended's (usually richer) input so LLM
          // children don't render with a truncated prompt history.
          const rawMessages = extractMessages(span.input);
          if (rawMessages) {
            const refreshed = normalizeInputMessages(rawMessages);
            if (refreshed.length > 0) existing.baseMessages = refreshed;
          }
        }
      }
      if (
        span.type === "model_step" &&
        !this.generationIdByStepId.has(span.id) &&
        span.parentSpanId
      ) {
        this.generationIdByStepId.set(span.id, span.parentSpanId);
      }

      // Record state transitions BEFORE converting, since the conversion reads
      // the accumulated history.
      this.updateGenerationStateOnSpanEnd(span);

      const readable = this.convertSpanToOtel(span, traceState);
      this.processor.onEnd(readable);
      if (this.config.realtime) {
        await this.processor.forceFlush();
      }
    } catch (err) {
      logger.error(
        `[MastraExporter] failed to export span ${span.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      traceState.activeSpanIds.delete(span.id);
      if (traceState.activeSpanIds.size === 0) {
        this.traceMap.delete(span.traceId);
      }
      if (span.type === "model_generation") {
        this.generationStateById.delete(span.id);
        this.generationAttrsById.delete(span.id);
      }
      if (span.type === "model_step") {
        this.generationIdByStepId.delete(span.id);
        this.stepIndexBySpanId.delete(span.id);
      }
    }
  }

  private initGenerationState(span: MastraExportedSpan): void {
    const rawMessages = extractMessages(span.input);
    const baseMessages = rawMessages ? normalizeInputMessages(rawMessages) : [];
    this.generationStateById.set(span.id, {
      baseMessages,
      turnsByStepIndex: new Map(),
      toolCallChildrenByStepIndex: new Map(),
      toolCallSpanIdToStepIndex: new Map(),
    });
  }

  private updateGenerationStateOnSpanEnd(span: MastraExportedSpan): void {
    if (span.type === "model_step") {
      const generationId = this.generationIdByStepId.get(span.id);
      if (!generationId) return;
      const gen = this.generationStateById.get(generationId);
      if (!gen) return;
      const stepIndex =
        this.stepIndexBySpanId.get(span.id) ??
        (typeof span.attributes?.stepIndex === "number"
          ? span.attributes.stepIndex
          : 0);
      this.stepIndexBySpanId.set(span.id, stepIndex);

      // Pair the declared `toolCalls` with tool_call children. Prefer id-based
      // pairing when children carry a toolCallId (parallel tool execution can
      // finish out of declaration order, so array-index pairing would
      // mis-attribute outputs). Fall back to arrival-order pairing among
      // unclaimed children when ids aren't available on the child spans.
      const output = span.output as Record<string, unknown> | undefined;
      const declaredToolCalls = Array.isArray(output?.toolCalls)
        ? (output.toolCalls as Array<Record<string, unknown>>)
        : [];
      const children = gen.toolCallChildrenByStepIndex.get(stepIndex) ?? [];
      const childrenById = new Map<string, ToolCallChild>();
      for (const c of children) {
        if (c.toolCallId) childrenById.set(c.toolCallId, c);
      }
      // Track already-paired children so the arrival-order fallback can't
      // re-pick a child that was already claimed by an id-based match.
      const consumed = new Set<ToolCallChild>();

      const turnMessages: AISdkMessage[] = [];
      const assistantMsg = buildAssistantMessageFromStepOutput(output);
      if (assistantMsg) turnMessages.push(assistantMsg);

      for (const dec of declaredToolCalls) {
        const toolCallId =
          (dec?.toolCallId as string | undefined) ??
          (dec?.id as string | undefined);
        if (!toolCallId) continue;
        let child = childrenById.get(toolCallId);
        if (child && consumed.has(child)) child = undefined;
        if (!child) {
          // Fallback: first unconsumed child in arrival order.
          child = children.find((c) => !consumed.has(c));
        }
        if (!child) continue;
        consumed.add(child);
        const toolName =
          (dec?.toolName as string | undefined) ??
          (dec?.name as string | undefined) ??
          child.toolName;
        turnMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName,
              output: child.output,
            },
          ],
        });
      }

      gen.turnsByStepIndex.set(stepIndex, turnMessages);
    } else if (span.type === "tool_call" || span.type === "mcp_tool_call") {
      // Record the tool_call child under its step so the step-end handler
      // can pair it with the declared toolCalls.
      const parentId = span.parentSpanId;
      if (!parentId) return;
      const generationId = this.generationIdByStepId.get(parentId);
      if (!generationId) return;
      const gen = this.generationStateById.get(generationId);
      if (!gen) return;
      const stepIndex =
        gen.toolCallSpanIdToStepIndex.get(span.id) ??
        this.stepIndexBySpanId.get(parentId);
      if (stepIndex === undefined) return;
      const list = gen.toolCallChildrenByStepIndex.get(stepIndex) ?? [];
      list.push({
        toolCallId: extractToolCallId(span),
        toolName: span.name?.replace(/^tool:\s*'?|'?$/g, "") || "tool",
        input: span.input,
        output: span.output,
      });
      gen.toolCallChildrenByStepIndex.set(stepIndex, list);
    }
  }

  private getOrCreateTraceState(traceId: string): TraceState {
    const existing = this.traceMap.get(traceId);
    if (existing) return existing;
    const created: TraceState = {
      spanPathById: new Map(),
      spanIdsPathById: new Map(),
      activeSpanIds: new Set(),
    };
    // Capture the caller's active OTel span synchronously, at the moment the
    // first event for this Mastra trace arrives — Mastra invokes exporter
    // handlers within the originating async context (see
    // `@mastra/observability` routeToHandler), so the user's `observe()`
    // span is still active here. Any later reads would be outside that
    // context (Mastra's event bus schedules handlers).
    if (this.config?.linkToActiveContext) {
      const activeSpan = trace.getActiveSpan();
      const ctx = activeSpan?.spanContext();
      if (ctx && ctx.traceId && ctx.spanId) {
        created.otelTraceId = normalizeTraceId(ctx.traceId);
        created.otelRootParentSpanId = normalizeSpanId(ctx.spanId);
        // Also capture SPAN_PATH / SPAN_IDS_PATH so we can prepend them to
        // every Mastra span's path. Laminar's backend/UI threads the span
        // tree on `lmnr.span.ids_path` — sharing the traceId alone isn't
        // enough to make the Mastra subtree render under `observe()`.
        const attrs = (activeSpan as unknown as { attributes?: Record<string, unknown> })
          .attributes;
        if (attrs) {
          const parentPath = attrs[SPAN_PATH];
          if (Array.isArray(parentPath) && parentPath.every((p) => typeof p === "string")) {
            created.otelParentSpanPath = parentPath;
          }
          const parentIdsPath = attrs[SPAN_IDS_PATH];
          if (
            Array.isArray(parentIdsPath) &&
            parentIdsPath.every((p) => typeof p === "string")
          ) {
            created.otelParentSpanIdsPath = parentIdsPath;
          }
        }
      }
    }
    this.traceMap.set(traceId, created);
    return created;
  }

  private setupIfNeeded(): void {
    if (this.isSetup || !this.config) return;
    if (!this.resource) {
      this.resource = createResource({
        [ATTR_SERVICE_NAME]: "mastra-service",
        [ATTR_SERVICE_VERSION]: SDK_VERSION,
        [ATTR_TELEMETRY_SDK_NAME]: "@lmnr-ai/lmnr",
        [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
        [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
      });
    }

    this.otlpExporter = new ExporterHttp({
      url: this.config.endpoint,
      headers: this.config.headers,
      timeoutMillis: this.config.timeoutMillis,
    });
    this.processor = this.config.disableBatch
      ? new SimpleSpanProcessor(this.otlpExporter)
      : new BatchSpanProcessor(this.otlpExporter, {
        maxExportBatchSize: this.config.batchSize,
        exportTimeoutMillis: this.config.timeoutMillis,
      });
    this.isSetup = true;
  }

  private convertSpanToOtel(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): ReadableSpan {
    // Prefer the OTel trace id captured at first-event time so Mastra spans
    // nest under the user's active `observe()` span instead of landing in
    // their own disconnected trace. Falls back to Mastra's own trace id when
    // there was no active OTel context or linking is disabled.
    const traceId = traceState.otelTraceId ?? normalizeTraceId(span.traceId);
    const spanId = normalizeSpanId(span.id);
    const startTime = dateToHrTime(span.startTime);
    const endTime = span.endTime ? dateToHrTime(span.endTime) : startTime;
    const duration = computeDuration(span.startTime, span.endTime);

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    // Reparent: Mastra-root spans (no parentSpanId) adopt the captured OTel
    // parent; everything else keeps its Mastra parent id verbatim, which is
    // still valid under the rewritten traceId since every descendant points
    // at a Mastra span id that we also rewrite onto the same OTel trace.
    const parentSpanIdNormalized = span.parentSpanId
      ? normalizeSpanId(span.parentSpanId)
      : traceState.otelRootParentSpanId;
    const parentSpanContext: SpanContext | undefined = parentSpanIdNormalized
      ? {
        traceId,
        spanId: parentSpanIdNormalized,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      }
      : undefined;

    const attributes = this.buildLaminarAttributes(span, traceState);
    const events: TimedEvent[] = [];
    let status: ReadableSpan["status"] = { code: SpanStatusCode.OK };
    if (span.errorInfo) {
      status = { code: SpanStatusCode.ERROR, message: span.errorInfo.message };
      events.push({
        name: "exception",
        attributes: {
          "exception.message": span.errorInfo.message,
          "exception.type": span.errorInfo.name ?? "Error",
          ...(span.errorInfo.stack
            ? { "exception.stacktrace": span.errorInfo.stack }
            : {}),
        },
        time: endTime,
      });
    }

    const readable = {
      name: span.name,
      kind: SpanKind.INTERNAL,
      spanContext: () => spanContext,
      parentSpanContext,
      startTime,
      endTime,
      status,
      attributes,
      links: [],
      events,
      duration,
      ended: true,
      resource: this.resource,
      instrumentationScope: this.scope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
    // Populate v1 aliases (parentSpanId / instrumentationLibrary) so spans
    // constructed here work under OTel SDK v1 processors/exporters too.
    makeSpanOtelV2Compatible(readable);
    return readable;
  }

  private buildLaminarAttributes(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): Record<string, any> {
    const attributes: Record<string, any> = {};

    const spanPath = traceState.spanPathById.get(span.id);
    const spanIdsPath = traceState.spanIdsPathById.get(span.id);
    if (spanPath) attributes[SPAN_PATH] = spanPath;
    if (spanIdsPath) attributes[SPAN_IDS_PATH] = spanIdsPath;

    const laminarSpanType = mapLaminarSpanType(span.type);
    attributes[SPAN_TYPE] = laminarSpanType;
    attributes[SPAN_INSTRUMENTATION_SOURCE] = "javascript";
    attributes[SPAN_SDK_VERSION] = SDK_VERSION;
    const langVersion = getLangVersion();
    if (langVersion) attributes[SPAN_LANGUAGE_VERSION] = langVersion;

    // Preserve the original Mastra span type so e.g. agent_run vs
    // model_generation (both DEFAULT) can be told apart downstream.
    attributes["lmnr.internal.mastra.span_type"] = span.type;

    const metadata = span.metadata ?? {};
    const sessionId = metadata.sessionId ?? metadata.session_id;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      attributes[SESSION_ID] = sessionId;
    }
    const userId = metadata.userId ?? metadata.user_id;
    if (typeof userId === "string" && userId.length > 0) {
      attributes[USER_ID] = userId;
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (
        key === "sessionId" ||
        key === "session_id" ||
        key === "userId" ||
        key === "user_id" ||
        value === undefined ||
        value === null
      ) {
        continue;
      }
      const av = toAttributeValue(value);
      if (av !== undefined) {
        attributes[`${ASSOCIATION_PROPERTIES}.metadata.${key}`] = av;
      }
    }
    if (span.isRootSpan && span.tags?.length) {
      attributes[`${ASSOCIATION_PROPERTIES}.tags`] = span.tags;
    }

    if (laminarSpanType === "LLM") {
      this.applyLlmAttributes(span, attributes);
    } else if (laminarSpanType === "TOOL") {
      this.applyToolAttributes(span, attributes);
    } else {
      if (span.input !== undefined) {
        attributes[SPAN_INPUT] = serializeJSON(span.input);
      }
      if (span.output !== undefined) {
        attributes[SPAN_OUTPUT] = serializeJSON(span.output);
      }
    }

    return attributes;
  }

  private applyLlmAttributes(
    span: MastraExportedSpan,
    attributes: Record<string, any>,
  ): void {
    const generationId =
      this.generationIdByStepId.get(span.id) ?? span.parentSpanId;
    const gen = generationId
      ? this.generationStateById.get(generationId)
      : undefined;
    const generationAttrs = generationId
      ? this.generationAttrsById.get(generationId)
      : undefined;

    const stepAttrs = (span.attributes ?? {}) as Record<string, any>;
    const stepIndex =
      this.stepIndexBySpanId.get(span.id) ??
      (typeof stepAttrs.stepIndex === "number" ? stepAttrs.stepIndex : 0);

    const provider = generationAttrs?.provider as string | undefined;
    const model = generationAttrs?.model as string | undefined;
    const responseModel = generationAttrs?.responseModel as string | undefined;
    if (provider)
      attributes[LaminarAttributes.PROVIDER] = normalizeProvider(provider);
    if (model) attributes[LaminarAttributes.REQUEST_MODEL] = model;
    if (responseModel)
      attributes[LaminarAttributes.RESPONSE_MODEL] = responseModel;
    else if (model) attributes[LaminarAttributes.RESPONSE_MODEL] = model;

    const usage = (stepAttrs.usage ?? generationAttrs?.usage) as
      | MastraUsageStats
      | undefined;
    Object.assign(attributes, formatUsage(usage));

    if (typeof stepAttrs.finishReason === "string") {
      attributes["gen_ai.response.finish_reason"] = stepAttrs.finishReason;
      attributes["ai.response.finishReason"] = stepAttrs.finishReason;
    }

    // Build the full message history for this step: base + every turn with
    // stepIndex < current stepIndex, flattened.
    const messages: AISdkMessage[] = gen ? [...gen.baseMessages] : [];
    if (gen) {
      for (let i = 0; i < stepIndex; i++) {
        const turn = gen.turnsByStepIndex.get(i);
        if (turn) messages.push(...turn);
      }
    }

    if (messages.length > 0) {
      attributes["ai.prompt.messages"] = serializeJSON(messages);
    } else if (span.input !== undefined) {
      attributes[SPAN_INPUT] = serializeJSON(span.input);
    }

    const out = span.output;
    if (out && typeof out === "object") {
      const outObj = out as Record<string, unknown>;
      if (typeof outObj.text === "string" && outObj.text.length > 0) {
        attributes["ai.response.text"] = outObj.text;
      }
      if (Array.isArray(outObj.toolCalls) && outObj.toolCalls.length > 0) {
        const normalized = (
          outObj.toolCalls as Array<Record<string, unknown>>
        ).map((tc) => ({
          toolCallType: tc.toolCallType ?? "function",
          toolCallId: tc.toolCallId ?? tc.id,
          toolName: tc.toolName ?? tc.name,
          args:
            typeof tc.args === "string"
              ? tc.args
              : tc.args !== undefined
                ? JSON.stringify(tc.args)
                : tc.input !== undefined
                  ? typeof tc.input === "string"
                    ? tc.input
                    : JSON.stringify(tc.input)
                  : undefined,
        }));
        attributes["ai.response.toolCalls"] = JSON.stringify(normalized);
      }
    } else if (out !== undefined) {
      attributes[SPAN_OUTPUT] = serializeJSON(out);
    }
  }

  private applyToolAttributes(
    span: MastraExportedSpan,
    attributes: Record<string, any>,
  ): void {
    if (span.input !== undefined) {
      attributes[SPAN_INPUT] = serializeJSON(span.input);
    }
    if (span.output !== undefined) {
      attributes[SPAN_OUTPUT] = serializeJSON(span.output);
    }
    const toolAttrs = (span.attributes ?? {}) as Record<string, any>;
    // Strip the `tool: 'x'` prefix Mastra prepends so the displayed name is
    // just the tool id.
    const cleanedName = span.name?.replace(/^tool:\s*'?|'?$/g, "") || span.name;
    if (cleanedName) attributes["ai.toolCall.name"] = cleanedName;
    if (typeof toolAttrs.toolType === "string") {
      attributes["ai.toolCall.type"] = toolAttrs.toolType;
    }
    if (typeof toolAttrs.mcpServer === "string") {
      attributes["mcp.server"] = toolAttrs.mcpServer;
    }
  }
}
