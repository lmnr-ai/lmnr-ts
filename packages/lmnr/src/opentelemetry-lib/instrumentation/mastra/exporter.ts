import {
  Context,
  context as contextApi,
  Span,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";

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
import { LaminarContextManager } from "../../tracing/context";
import { getSpanProcessor, getTracerProvider } from "../../tracing/index";
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
  dateToHrTime,
  extractMessages,
  extractToolCallId,
  formatUsage,
  mapLaminarSpanType,
  normalizeInputMessages,
  normalizeProvider,
  serializeJSON,
  stringifyArgs,
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
    realtime: boolean;
    linkToActiveContext: boolean;
  };

  private readonly traceMap: Map<string, TraceState> = new Map();
  private readonly generationStateById: Map<string, GenerationState> =
    new Map();
  private readonly generationAttrsById: Map<string, Record<string, unknown>> =
    new Map();
  private readonly generationIdByStepId: Map<string, string> = new Map();
  // Remember step index per step span so tool_call children can look up which
  // step they belong to (fan-in by arrival order).
  private readonly stepIndexBySpanId: Map<string, number> = new Map();
  // Live OTel spans created via `tracer.startSpan` at span_started time, held
  // until span_ended. Lookups by Mastra span id let us:
  //   - apply attributes / status / exception on the live span at end-time;
  //   - resolve a Mastra child's parent context to the *mutated* live span,
  //     so the SDK threads parent linkage with our Mastra-derived ids.
  private readonly liveOtelSpanByMastraId: Map<string, Span> = new Map();

  private warnedNotInitialized = false;

  constructor(options: MastraExporterOptions = {}) {
    this.config = {
      realtime: options.realtime ?? false,
      linkToActiveContext: options.linkToActiveContext ?? true,
    };
  }

  // Mastra calls `init({ config: { serviceName } })` on registration. We rely
  // on Laminar's tracer provider (set by `Laminar.initialize()`) for span
  // creation and export, so this is a no-op kept only for API compatibility
  // with Mastra's exporter contract.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  init(_options?: unknown): void {}

  async exportTracingEvent(event: MastraTracingEvent): Promise<void> {
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
    // Flush Laminar's span processor — the only pipeline our spans flow
    // through. No-op when Laminar isn't initialized.
    const processor = getSpanProcessor();
    if (!processor) return;
    try {
      await processor.forceFlush();
    } catch (err) {
      logger.error(
        `[MastraExporter] forceFlush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  shutdown(): Promise<void> {
    // Don't tear down Laminar's pipeline here — it may still be needed by
    // other instrumentations. Just drop our per-trace bookkeeping.
    this.traceMap.clear();
    this.generationStateById.clear();
    this.generationAttrsById.clear();
    this.generationIdByStepId.clear();
    this.stepIndexBySpanId.clear();
    this.liveOtelSpanByMastraId.clear();
    return Promise.resolve();
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

    this.startOtelSpan(span, traceState);
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

    const traceState = this.getOrCreateTraceState(span.traceId);

    try {
      // Backfill path/state when SPAN_STARTED was missed (e.g. exporter
      // registered mid-trace, the global SDK was unrecording at start time).
      // Inside the try so a throw here still runs cleanup.
      if (!traceState.spanPathById.has(span.id)) {
        this.recordSpanPath(span, traceState);
        // Mirror handleSpanStarted: register the span as active so the
        // finally block's `activeSpanIds.delete` is balanced.
        traceState.activeSpanIds.add(span.id);
      }
      if (
        span.type === MastraSpanType.MODEL_GENERATION &&
        !this.generationStateById.has(span.id)
      ) {
        this.initGenerationState(span);
      }
      if (
        span.type === MastraSpanType.MODEL_STEP &&
        !this.generationIdByStepId.has(span.id) &&
        span.parentSpanId
      ) {
        this.generationIdByStepId.set(span.id, span.parentSpanId);
      }
      if (!this.liveOtelSpanByMastraId.has(span.id)) {
        // Span_ended without a prior span_started, or the SDK was a
        // NonRecording proxy at start time and we couldn't keep a live
        // reference. Create the live span now (zero-duration if Mastra
        // didn't carry startTime).
        this.startOtelSpan(span, traceState);
      }

      // Record state transitions BEFORE applying attrs; LLM attribute
      // construction reads the accumulated step turn history.
      this.updateGenerationStateOnSpanEnd(span);

      const otelSpan = this.liveOtelSpanByMastraId.get(span.id);
      if (!otelSpan) {
        // `Laminar.initialize()` wasn't called, so the tracer was a noop
        // and `startOtelSpan` couldn't keep a recording span. Skip silently
        // — `startOtelSpan` already logged a one-time warning.
        return;
      }

      this.applyEndAttributes(span, otelSpan, traceState);

      if (span.errorInfo) {
        otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: span.errorInfo.message,
        });
        otelSpan.recordException({
          name: span.errorInfo.name ?? "Error",
          message: span.errorInfo.message,
          stack: span.errorInfo.stack,
        });
      }

      const endTime = span.endTime
        ? dateToHrTime(span.endTime)
        : dateToHrTime(span.startTime);
      otelSpan.end(endTime);

      // `Span.end()` synchronously fanned out to every processor on
      // Laminar's tracer provider. No manual onEnd push needed.
      if (this.config.realtime) {
        await getSpanProcessor()?.forceFlush();
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
      this.liveOtelSpanByMastraId.delete(span.id);
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

  // Create a real OTel span via Laminar's tracer, then mutate its ids /
  // parent references so they line up with Mastra's. We use a real span (not
  // a manually-constructed ReadableSpan) so the registered LaminarSpanProcessor
  // sees it on `onStart` and can attach association properties from the
  // active context.
  private startOtelSpan(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    // `Laminar.initialize()` is expected to have set up the tracer provider.
    // If it wasn't called, `getTracerProvider()` falls back to the global
    // OTel API which is a NoopTracerProvider, and `tracer.startSpan` will
    // return a NonRecordingSpan — caught below.
    const tracer = getTracerProvider().getTracer(
      "@lmnr-ai/lmnr",
      SDK_VERSION,
    );
    const parentCtx = this.buildParentContext(span, traceState);

    const otelSpan = tracer.startSpan(
      span.name,
      {
        startTime: dateToHrTime(span.startTime),
        kind: SpanKind.INTERNAL,
      },
      parentCtx,
    );

    if (!otelSpan.isRecording()) {
      this.warnNotInitializedOnce();
      return;
    }

    // Stamp Mastra-derived ids over the SDK's auto-generated ones. Mutates
    // the SpanContext object the SDK holds internally — `spanContext()`
    // returns the same reference each call.
    const mastraSpanId = normalizeOtelSpanId(span.id);
    const mastraTraceId =
      traceState.otelTraceId ?? normalizeOtelTraceId(span.traceId);
    Object.assign(otelSpan.spanContext(), {
      traceId: mastraTraceId,
      spanId: mastraSpanId,
    });

    // Patch parent references. We set both `parentSpanContext` (SDK v2) and
    // `parentSpanId` (SDK v1 alias) so this works across SDK versions.
    const parentSpanIdNormalized = span.parentSpanId
      ? normalizeOtelSpanId(span.parentSpanId)
      : traceState.otelRootParentSpanId;
    if (parentSpanIdNormalized) {
      const parentSpanContext: SpanContext = {
        traceId: mastraTraceId,
        spanId: parentSpanIdNormalized,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      };
      Object.assign(otelSpan, {
        parentSpanId: parentSpanIdNormalized,
        parentSpanContext,
      });
    } else {
      // Mastra root with no captured outer span — clear whatever parent the
      // SDK inferred from `parentCtx` so the exported span reads as a root.
      Object.assign(otelSpan, {
        parentSpanId: undefined,
        parentSpanContext: undefined,
      });
    }

    // Globally-registered processors (e.g. LaminarSpanProcessor) wrote
    // `lmnr.span.path` / `lmnr.span.ids_path` during their `onStart` hook
    // using the SDK's auto-generated span id — overwrite with our
    // Mastra-derived versions so Laminar's UI nests the subtree correctly.
    const spanPath = traceState.spanPathById.get(span.id);
    const spanIdsPath = traceState.spanIdsPathById.get(span.id);
    if (spanPath) otelSpan.setAttribute(SPAN_PATH, spanPath);
    if (spanIdsPath) otelSpan.setAttribute(SPAN_IDS_PATH, spanIdsPath);

    this.liveOtelSpanByMastraId.set(span.id, otelSpan);
  }

  private warnNotInitializedOnce(): void {
    if (this.warnedNotInitialized) return;
    this.warnedNotInitialized = true;
    logger.warn(
      "[MastraExporter] Laminar tracer is not initialized — Mastra spans " +
        "will be dropped. Call `Laminar.initialize({ projectApiKey: ... })` " +
        "before constructing `MastraExporter`.",
    );
  }

  // Pick the OTel context whose active span will become the new Mastra
  // span's parent. Resolution order:
  //   1. Mastra child? Use the *live* (mutated) parent span we already
  //      created — its spanContext exposes the Mastra-derived parent ids.
  //   2. Mastra root? Use the outer `observe()` / `Laminar.startActiveSpan()`
  //      span captured at first-event time (if linking is enabled).
  //   3. Otherwise the bare context (Laminar's first, OTel's as fallback).
  private buildParentContext(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): Context {
    const baseCtx =
      LaminarContextManager.getContext() ?? contextApi.active();

    if (span.parentSpanId) {
      const parentLive = this.liveOtelSpanByMastraId.get(span.parentSpanId);
      if (parentLive) return trace.setSpan(baseCtx, parentLive);
    }

    if (traceState.otelTraceId && traceState.otelRootParentSpanId) {
      const wrapped = trace.wrapSpanContext({
        traceId: traceState.otelTraceId,
        spanId: traceState.otelRootParentSpanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      });
      return trace.setSpan(baseCtx, wrapped);
    }

    return baseCtx;
  }

  private applyEndAttributes(
    span: MastraExportedSpan,
    otelSpan: Span,
    traceState: TraceState,
  ): void {
    const attributes = this.buildLaminarAttributes(span, traceState);
    // Path attrs were already written in `startOtelSpan`. Skip them on the
    // bulk re-apply both to avoid pointless setAttribute churn and to keep
    // the path values stable if some upstream processor mutated them.
    delete attributes[SPAN_PATH];
    delete attributes[SPAN_IDS_PATH];
    otelSpan.setAttributes(attributes);
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
