import {
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
import {
  initializeLogger,
  normalizeOtelSpanId,
  normalizeOtelTraceId,
  otelSpanIdToUUID,
} from "../../../utils";
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
import { LaminarContextManager } from "../../tracing/context";
import {
  AISdkMessage,
  MastraExportedSpan,
  MastraExporterOptions,
  MastraSpanType,
  MastraTracingEvent,
  MastraUsageStats,
} from "./types";
import {
  buildAssistantMessageFromStepOutput,
  cleanMastraToolName,
  computeDuration,
  dateToHrTime,
  extractMessages,
  extractToolCallId,
  formatUsage,
  mapLaminarSpanType,
  normalizeInputMessages,
  normalizeProvider,
  serializeJSON,
  stringifyArgs,
  stripTrailingSlash,
  toAttributeValue,
} from "./utils";

const logger = initializeLogger();

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
  // Accumulated reasoning text per step, built up from MODEL_CHUNK children
  // with `chunkType: "reasoning"`. Mastra drops reasoning from
  // `MODEL_STEP.output`/`attributes` entirely (see `#endStepSpan` in
  // `@mastra/observability/dist/index.js`), and `MODEL_GENERATION.output`
  // only carries a flat cross-step `reasoningText` string — neither preserves
  // per-step boundaries. Reasoning chunks DO, and they end before the parent
  // MODEL_STEP ends, so accumulating from them is the only way to surface
  // thinking tokens on the step's LLM span.
  reasoningTextByStepIndex: Map<number, string>;
}

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
    if (span.type === MastraSpanType.MODEL_GENERATION && span.attributes) {
      const existing = this.generationAttrsById.get(span.id);
      // Always spread into a fresh object (even on first insert): Mastra
      // owns `span.attributes` and could reuse or mutate it between events,
      // which would silently corrupt the stored snapshot children read at
      // `applyLlmAttributes` time.
      this.generationAttrsById.set(
        span.id,
        existing
          ? { ...existing, ...span.attributes }
          : { ...span.attributes },
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
    if (span.type === MastraSpanType.MODEL_CHUNK) return;

    const traceState = this.getOrCreateTraceState(span.traceId);
    const parentId = span.parentSpanId;

    this.recordSpanPath(span, traceState);
    traceState.activeSpanIds.add(span.id);

    if (span.type === MastraSpanType.MODEL_GENERATION) {
      this.initGenerationState(span);
    } else if (span.type === MastraSpanType.MODEL_STEP && parentId) {
      this.generationIdByStepId.set(span.id, parentId);
      const stepIndex =
        typeof span.attributes?.stepIndex === "number"
          ? span.attributes.stepIndex
          : 0;
      this.stepIndexBySpanId.set(span.id, stepIndex);
    }
  }

  // Build `spanPath` / `spanIdsPath` for a Mastra span and store them on the
  // trace state. For Mastra roots we seed from the captured outer observe()
  // path so Laminar's UI nests the subtree underneath; for Mastra descendants
  // we reuse the parent Mastra span's stored path (already has the outer
  // path prepended).
  private recordSpanPath(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    const parentId = span.parentSpanId;
    const parentPath = parentId
      ? traceState.spanPathById.get(parentId)
      : traceState.otelParentSpanPath;
    const parentIdsPath = parentId
      ? traceState.spanIdsPathById.get(parentId)
      : traceState.otelParentSpanIdsPath;

    // Derive the UUID from the normalized (16-hex-char) span id so this
    // path entry agrees with what `convertSpanToOtel` produces via
    // `normalizeOtelSpanId` → OTel span id. Mastra occasionally emits span ids
    // longer than 16 hex chars; passing the raw value here would truncate
    // differently from the exported id and Laminar's UI (which threads
    // nesting on `lmnr.span.ids_path`) would render the Mastra subtree flat.
    const spanUuid = otelSpanIdToUUID(normalizeOtelSpanId(span.id));
    const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
    const spanIdsPath = parentIdsPath
      ? [...parentIdsPath, spanUuid]
      : [spanUuid];

    traceState.spanPathById.set(span.id, spanPath);
    traceState.spanIdsPathById.set(span.id, spanIdsPath);
  }

  private async handleSpanEnded(span: MastraExportedSpan): Promise<void> {
    if (!this.config) return;
    if (span.type === MastraSpanType.MODEL_CHUNK) {
      // MODEL_CHUNK spans are streaming noise as far as trace output goes
      // (dropped below), but reasoning chunks carry the thinking text for
      // their parent MODEL_STEP — accumulate before dropping. Mastra emits
      // these as `attributes.chunkType: "reasoning"` with `output.text` =
      // the delta text accumulated by its own chunk-span transform, and
      // the chunk ends BEFORE its parent MODEL_STEP ends, so the reasoning
      // is available when we build the step's LLM attributes.
      this.captureReasoningChunk(span);
      return;
    }

    this.setupIfNeeded();
    if (!this.processor) return;

    const traceState = this.getOrCreateTraceState(span.traceId);

    try {
      // Backfill path info when SPAN_STARTED was missed (e.g. exporter
      // registered mid-trace or a re-entrant span_ended without a matching
      // span_started). Inside the try so a throw here still runs cleanup.
      if (!traceState.spanPathById.has(span.id)) {
        this.recordSpanPath(span, traceState);
        // Mirror handleSpanStarted: register the span as active so the
        // finally block's `activeSpanIds.delete` is balanced. Without this,
        // `activeSpanIds.size === 0` could already be true on entry and the
        // trace state (including captured OTel context and accumulated
        // path info for later children) would be dropped prematurely.
        traceState.activeSpanIds.add(span.id);
      }

      if (
        span.type === MastraSpanType.MODEL_GENERATION &&
        !this.generationStateById.has(span.id)
      ) {
        // Defensive: only fires if we somehow missed `span_started`. There's
        // no point refreshing `baseMessages` here even when `span.input` is
        // richer than what `span_started` carried — every MODEL_STEP child
        // has already ended and serialized its prompt by the time the parent
        // generation ends, so nothing downstream would read the new value.
        this.initGenerationState(span);
      }
      if (
        span.type === MastraSpanType.MODEL_STEP &&
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
      if (span.type === MastraSpanType.MODEL_GENERATION) {
        this.generationStateById.delete(span.id);
        this.generationAttrsById.delete(span.id);
      }
      if (span.type === MastraSpanType.MODEL_STEP) {
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
      reasoningTextByStepIndex: new Map(),
    });
  }

  // Accumulate reasoning text from a MODEL_CHUNK into its parent MODEL_STEP's
  // slot on the surrounding MODEL_GENERATION. Chunks' `parentSpanId` is the
  // step span's id, and the step span was registered in `stepIndexBySpanId` /
  // `generationIdByStepId` at span_started, so we can resolve the slot
  // without any extra bookkeeping.
  //
  // When a step produces multiple separate reasoning blocks (reasoning-start
  // / reasoning-end fires more than once inside one step — Mastra starts a
  // new chunk span each time), we concatenate their texts in arrival order
  // to mirror Mastra's own `#bufferedReasoning` behavior.
  private captureReasoningChunk(span: MastraExportedSpan): void {
    const attrs = span.attributes ?? {};
    if (attrs.chunkType !== "reasoning") return;
    const output = span.output;
    if (!output || typeof output !== "object") return;
    const text = (output as Record<string, unknown>).text;
    if (typeof text !== "string" || text.length === 0) return;

    const stepSpanId = span.parentSpanId;
    if (!stepSpanId) return;
    const generationId = this.generationIdByStepId.get(stepSpanId);
    if (!generationId) return;
    const gen = this.generationStateById.get(generationId);
    if (!gen) return;
    const stepIndex = this.stepIndexBySpanId.get(stepSpanId);
    if (stepIndex === undefined) return;

    const existing = gen.reasoningTextByStepIndex.get(stepIndex);
    gen.reasoningTextByStepIndex.set(
      stepIndex,
      existing ? existing + text : text,
    );
  }

  private updateGenerationStateOnSpanEnd(span: MastraExportedSpan): void {
    if (span.type === MastraSpanType.MODEL_STEP) {
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
        // Don't skip declarations with a missing id:
        // `buildAssistantMessageFromStepOutput` still emitted a `tool-call`
        // part for this declaration, so we must emit a matching tool-result
        // or subsequent steps will see a broken history (assistant calls a
        // tool, no result follows). Fall through to arrival-order pairing in
        // that case, using whatever id the child span carries (may be
        // undefined).
        let child = toolCallId ? childrenById.get(toolCallId) : undefined;
        if (child && consumed.has(child)) child = undefined;
        if (!child) {
          // Fallback: first unconsumed child in arrival order.
          child = children.find((c) => !consumed.has(c));
        }
        if (!child) continue;
        consumed.add(child);
        const resolvedToolCallId = toolCallId ?? child.toolCallId;
        const toolName =
          (dec?.toolName as string | undefined) ??
          (dec?.name as string | undefined) ??
          child.toolName;
        turnMessages.push({
          role: "tool",
          tool_call_id: resolvedToolCallId,
          content: [
            {
              type: "tool-result",
              toolCallId: resolvedToolCallId,
              toolName,
              output: child.output,
            },
          ],
        });
      }

      gen.turnsByStepIndex.set(stepIndex, turnMessages);
    } else if (
      span.type === MastraSpanType.TOOL_CALL ||
      span.type === MastraSpanType.MCP_TOOL_CALL
    ) {
      // Record the tool_call child under its step so the step-end handler
      // can pair it with the declared toolCalls. Tool spans always end
      // before their parent MODEL_STEP ends, so the parent's stepIndex is
      // still in `stepIndexBySpanId` here.
      const parentId = span.parentSpanId;
      if (!parentId) return;
      const generationId = this.generationIdByStepId.get(parentId);
      if (!generationId) return;
      const gen = this.generationStateById.get(generationId);
      if (!gen) return;
      const stepIndex = this.stepIndexBySpanId.get(parentId);
      if (stepIndex === undefined) return;
      const list = gen.toolCallChildrenByStepIndex.get(stepIndex) ?? [];
      list.push({
        toolCallId: extractToolCallId(span),
        toolName: cleanMastraToolName(span.name) || "tool",
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
    // Capture the caller's active span synchronously, at the moment the
    // first event for this Mastra trace arrives — Mastra invokes exporter
    // handlers within the originating async context (see
    // `@mastra/observability` routeToHandler), so the caller's wrapper
    // span is still active here. Any later reads would be outside that
    // context (Mastra's event bus schedules handlers).
    //
    // Two stacks to consult, in order:
    //  1. Laminar's own context manager — the only place spans started via
    //     `Laminar.startActiveSpan()` are tracked. That helper writes onto
    //     a separate AsyncLocalStorage instance and never touches OTel's
    //     standard context, so step (2) alone wouldn't see them.
    //  2. OTel's standard active span — set by `observe()` via
    //     `context.with(...)` and by any other OTel-aware instrumentation.
    if (this.config?.linkToActiveContext) {
      const activeSpan =
        trace.getSpan(LaminarContextManager.getContext()) ??
        trace.getActiveSpan();
      const ctx = activeSpan?.spanContext();
      if (ctx && ctx.traceId && ctx.spanId) {
        created.otelTraceId = normalizeOtelTraceId(ctx.traceId);
        created.otelRootParentSpanId = normalizeOtelSpanId(ctx.spanId);
        // Also capture SPAN_PATH / SPAN_IDS_PATH so we can prepend them to
        // every Mastra span's path. Laminar's backend/UI threads the span
        // tree on `lmnr.span.ids_path` — sharing the traceId alone isn't
        // enough to make the Mastra subtree render under `observe()`.
        const attrs = (
          activeSpan as unknown as { attributes?: Record<string, unknown> }
        ).attributes;
        if (attrs) {
          const parentPath = attrs[SPAN_PATH];
          if (
            Array.isArray(parentPath) &&
            parentPath.every((p) => typeof p === "string")
          ) {
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
    const traceId = traceState.otelTraceId ?? normalizeOtelTraceId(span.traceId);
    const spanId = normalizeOtelSpanId(span.id);
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
      ? normalizeOtelSpanId(span.parentSpanId)
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

    const stepAttrs = span.attributes ?? {};
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
    const reasoningText = gen?.reasoningTextByStepIndex.get(stepIndex);
    if (out && typeof out === "object") {
      const outObj = out as Record<string, unknown>;
      if (typeof outObj.text === "string" && outObj.text.length > 0) {
        attributes["ai.response.text"] = outObj.text;
      }
      const normalizedToolCalls =
        Array.isArray(outObj.toolCalls) && outObj.toolCalls.length > 0
          ? (outObj.toolCalls as Array<Record<string, unknown>>).map((tc) => ({
            toolCallType: tc.toolCallType ?? "function",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: stringifyArgs(tc.args ?? tc.input),
          }))
          : [];
      if (normalizedToolCalls.length > 0) {
        attributes["ai.response.toolCalls"] =
          JSON.stringify(normalizedToolCalls);
      }
      // Emit OTel GenAI semconv `gen_ai.output.messages` with a `thinking`
      // part when this step had reasoning chunks. Laminar's backend
      // preserves this attribute verbatim on `self.output` and the frontend
      // GenAI parser maps `thinking` → ModelMessage `reasoning`, rendered
      // with a "Thinking" label in the trace UI.
      if (typeof reasoningText === "string" && reasoningText.length > 0) {
        const parts: Array<Record<string, unknown>> = [
          { type: "thinking", content: reasoningText },
        ];
        if (typeof outObj.text === "string" && outObj.text.length > 0) {
          parts.push({ type: "text", content: outObj.text });
        }
        for (const tc of normalizedToolCalls) {
          let argsObj: unknown = tc.args;
          if (typeof argsObj === "string") {
            try {
              argsObj = JSON.parse(argsObj);
            } catch {
              // leave as string; backend still accepts it
            }
          }
          parts.push({
            type: "tool_call",
            id: tc.toolCallId,
            name: tc.toolName,
            arguments: argsObj,
          });
        }
        attributes["gen_ai.output.messages"] = JSON.stringify([
          { role: "assistant", parts },
        ]);
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
    const toolAttrs = span.attributes ?? {};
    // Strip the `tool: 'x'` prefix Mastra prepends so the displayed name is
    // just the tool id.
    const cleanedName = cleanMastraToolName(span.name) || span.name;
    if (cleanedName) attributes["ai.toolCall.name"] = cleanedName;
    if (typeof toolAttrs.toolType === "string") {
      attributes["ai.toolCall.type"] = toolAttrs.toolType;
    }
    if (typeof toolAttrs.mcpServer === "string") {
      attributes["mcp.server"] = toolAttrs.mcpServer;
    }
  }
}
