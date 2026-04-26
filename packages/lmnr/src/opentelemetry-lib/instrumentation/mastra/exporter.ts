/**
 * LaminarMastraExporter
 *
 * Plugs into Mastra's own observability bus and converts each Mastra
 * ExportedSpan into an OTel ReadableSpan, handed to the existing
 * LaminarSpanProcessor for OTLP transport.
 *
 * Types are re-declared locally in ./types.ts rather than imported from
 * `@mastra/core` / `@mastra/observability` — those packages currently ship
 * broken `json-schema` references that break our `.d.ts` bundling.
 * `BaseExporter` is loaded at runtime via `require` to keep Mastra an
 * optional peer dependency.
 */

/* eslint-disable @typescript-eslint/no-explicit-any,
   @typescript-eslint/no-require-imports,
   @typescript-eslint/no-unsafe-call,
   @typescript-eslint/require-await */

import {
  type Attributes,
  type HrTime,
  type Link,
  SpanKind,
  type SpanStatus,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import {
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from "@opentelemetry/semantic-conventions";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger, otelSpanIdToUUID } from "../../../utils";
import {
  ASSOCIATION_PROPERTIES,
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
import { getSpanProcessor } from "../../tracing/index";
import {
  type MastraExportedSpan,
  type MastraModelGenerationAttributes,
  MastraSpanType,
  type MastraTracingEvent,
  MastraTracingEventType,
  type MastraUsageStats,
} from "./types";

const GEN_AI_SYSTEM = "gen_ai.system";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const GEN_AI_CACHE_WRITE_INPUT_TOKENS =
  "gen_ai.usage.cache_creation_input_tokens";
const GEN_AI_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read_input_tokens";

type LaminarSpanType = "DEFAULT" | "LLM" | "TOOL";

type CompletedStep = {
  stepIndex: number;
  assistant: OpenAIAssistantTurn;
};

type OpenAIAssistantTurn = {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

type CompletedToolCall = {
  stepIndex: number; // The step that REQUESTED this tool call (so we interleave after it)
  message: {
    role: "tool";
    tool_call_id: string;
    name?: string;
    content: string;
  };
};

type ModelGenerationState = {
  // Messages from the MODEL_GENERATION span input (initial conversation)
  initialMessages: unknown[] | null;
  // Tracks the next step index expected (0, 1, 2, ...) based on SPAN_ENDED order
  nextStepIndex: number;
  // Assistant turns recovered from each completed MODEL_STEP's output
  steps: CompletedStep[];
  // Tool outputs recovered from TOOL_CALL spans, tagged with the step that produced them
  toolOutputs: CompletedToolCall[];
};

type TraceState = {
  spanPathById: Map<string, string[]>;
  spanIdsPathById: Map<string, string[]>;
  activeSpanIds: Set<string>;
  // Per-MODEL_GENERATION state used to reconstruct the full multi-step
  // conversation history (since Mastra's own step input is destroyed by
  // `@mastra/observability`'s `normalizeMessages` for OpenAI Responses API).
  modelGenerations: Map<string, ModelGenerationState>;
  // Ancestor MODEL_GENERATION id for any descendant span. Populated on
  // SPAN_STARTED so later children can find the right ModelGenerationState.
  modelGenerationAncestor: Map<string, string>;
  // Completed TOOL_CALL outputs grouped by their parent MODEL_STEP span id, in
  // the order their TOOL_CALL spans ended. Consumed when the MODEL_STEP ends.
  toolOutputsByStep: Map<string, unknown[]>;
  // Type of each started span, so we can identify whether a parent span is a
  // MODEL_STEP without introspecting external state.
  spanTypeById: Map<string, MastraSpanType>;
};

const logger = initializeLogger();

const loadBaseExporter = (): any => {
  try {
    return require("@mastra/observability").BaseExporter;
  } catch {
    return class FallbackBaseExporter {
      // Minimal shape so LaminarMastraExporter still extends something when
      // @mastra/observability is not installed (e.g. tests, older Mastra).
      constructor(config?: any) {
        void config;
      }
      __setLogger(logger: any): void {
        void logger;
      }
      async exportTracingEvent(event: MastraTracingEvent): Promise<void> {
        await (this as any)._exportTracingEvent(event);
      }
      async _exportTracingEvent(event: MastraTracingEvent): Promise<void> {
        void event;
      }
      async flush(): Promise<void> {}
      async shutdown(): Promise<void> {}
    };
  }
};

// We load BaseExporter lazily on first instantiation rather than at module load
// time, so that the module remains cheap to import even when Mastra is absent.
let BaseExporterRef: any = null;
const getBaseExporter = (): any => {
  if (!BaseExporterRef) BaseExporterRef = loadBaseExporter();
  return BaseExporterRef;
};

export interface LaminarMastraExporterConfig {
  /** Log / flush after each SPAN_ENDED — useful for serverless. */
  realtime?: boolean;
  /** Override for `service.name`. Defaults to "mastra-service". */
  serviceName?: string;
  /** Passed through to BaseExporter config. */
  logger?: any;
  logLevel?: string;
}

// Using a factory so we can extend the dynamically-loaded BaseExporter.
export class LaminarMastraExporter extends getBaseExporter() {
  name = "laminar";

  private traceMap = new Map<string, TraceState>();
  private resource?: Resource;
  private scope?: InstrumentationScope;
  private realtime: boolean;
  private serviceName: string;

  constructor(config: LaminarMastraExporterConfig = {}) {
    super(config);
    this.realtime = config.realtime ?? false;
    this.serviceName = config.serviceName ?? "mastra-service";
  }

  init(options: { config?: { serviceName?: string } }): void {
    const serviceName = options.config?.serviceName || this.serviceName;
    this.resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_NAME]: "@lmnr-ai/lmnr",
      [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
    });
    this.scope = { name: "lmnr.mastra", version: SDK_VERSION };
  }

  protected async _exportTracingEvent(
    event: MastraTracingEvent,
  ): Promise<void> {
    // Mastra emits SPAN_STARTED/SPAN_ENDED pairs for point-in-time events too
    // (isEvent: true). Those aren't real spans — they're markers with no
    // meaningful duration — so skip them to avoid polluting the trace with
    // zero-width OTel spans.
    if (event.exportedSpan.isEvent) return;
    if (event.type === MastraTracingEventType.SPAN_STARTED) {
      this.handleSpanStarted(event.exportedSpan);
      return;
    }
    if (event.type !== MastraTracingEventType.SPAN_ENDED) return;
    await this.handleSpanEnded(event.exportedSpan);
  }

  private handleSpanStarted(span: MastraExportedSpan): void {
    const traceState = this.getOrCreateTraceState(span.traceId);
    const parentId = span.parentSpanId;
    const parentPath = parentId
      ? traceState.spanPathById.get(parentId)
      : undefined;
    const parentIdsPath = parentId
      ? traceState.spanIdsPathById.get(parentId)
      : undefined;
    const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
    const normalizedId = otelSpanIdToUUID(normalizeSpanId(span.id));
    const spanIdsPath = parentIdsPath
      ? [...parentIdsPath, normalizedId]
      : [normalizedId];
    traceState.spanPathById.set(span.id, spanPath);
    traceState.spanIdsPathById.set(span.id, spanIdsPath);
    traceState.activeSpanIds.add(span.id);
    traceState.spanTypeById.set(span.id, span.type);

    this.updateModelGenerationAncestor(span, traceState);
    if (span.type === MastraSpanType.MODEL_GENERATION) {
      traceState.modelGenerations.set(span.id, {
        initialMessages: extractInitialMessages(span.input),
        nextStepIndex: 0,
        steps: [],
        toolOutputs: [],
      });
    }
    if (span.type === MastraSpanType.MODEL_STEP) {
      traceState.toolOutputsByStep.set(span.id, []);
    }
  }

  private updateModelGenerationAncestor(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    if (span.type === MastraSpanType.MODEL_GENERATION) {
      traceState.modelGenerationAncestor.set(span.id, span.id);
      return;
    }
    const parentId = span.parentSpanId;
    if (!parentId) return;
    const parentAncestor = traceState.modelGenerationAncestor.get(parentId);
    if (parentAncestor) {
      traceState.modelGenerationAncestor.set(span.id, parentAncestor);
    }
  }

  private async handleSpanEnded(span: MastraExportedSpan): Promise<void> {
    const processor = getSpanProcessor();
    if (!processor) {
      logger.debug(
        "[LaminarMastraExporter] LaminarSpanProcessor not initialized — dropping span",
      );
      return;
    }
    const traceState = this.getOrCreateTraceState(span.traceId);

    if (!traceState.spanPathById.has(span.id)) {
      const parentId = span.parentSpanId;
      const parentPath = parentId
        ? traceState.spanPathById.get(parentId)
        : undefined;
      const parentIdsPath = parentId
        ? traceState.spanIdsPathById.get(parentId)
        : undefined;
      const spanPath = parentPath ? [...parentPath, span.name] : [span.name];
      const spanIdsPath = parentIdsPath
        ? [...parentIdsPath, otelSpanIdToUUID(span.id)]
        : [otelSpanIdToUUID(span.id)];
      traceState.spanPathById.set(span.id, spanPath);
      traceState.spanIdsPathById.set(span.id, spanIdsPath);
    }

    // Tool call output must be recorded BEFORE we build the ReadableSpan so
    // subsequent MODEL_STEP spans (processed next) can see it. MODEL_STEP
    // output is recorded AFTER building, so its own input doesn't include its
    // own output in the reconstructed history.
    if (
      span.type === MastraSpanType.TOOL_CALL ||
      span.type === MastraSpanType.MCP_TOOL_CALL
    ) {
      this.recordToolCallCompletion(span, traceState);
    }
    // On MODEL_STEP end, pair its output.toolCalls[] with the child TOOL_CALL
    // outputs (captured in order above) and attribute them to THIS step. Must
    // happen before recordModelStepCompletion so tool outputs are labeled with
    // the current step index.
    if (span.type === MastraSpanType.MODEL_STEP) {
      this.pairModelStepToolCalls(span, traceState);
    }

    try {
      const readable = this.convertSpanToOtel(span, traceState);
      processor.onEnd(readable as any);
      if (this.realtime) await processor.forceFlush();
    } catch (error) {
      logger.debug(
        `[LaminarMastraExporter] Failed to export span ${span.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (span.type === MastraSpanType.MODEL_STEP) {
        this.recordModelStepCompletion(span, traceState);
        traceState.toolOutputsByStep.delete(span.id);
      }
      if (span.type === MastraSpanType.MODEL_GENERATION) {
        traceState.modelGenerations.delete(span.id);
      }
      traceState.activeSpanIds.delete(span.id);
      traceState.modelGenerationAncestor.delete(span.id);
      traceState.spanTypeById.delete(span.id);
      if (traceState.activeSpanIds.size === 0) {
        this.traceMap.delete(span.traceId);
      }
    }
  }

  /**
   * TOOL_CALL spans end BEFORE their parent MODEL_STEP ends. We collect their
   * outputs keyed by the parent MODEL_STEP id; the MODEL_STEP-end handler then
   * pairs them with `output.toolCalls[]` (which carries `toolCallId`) to emit
   * OpenAI-shape `{role:"tool", tool_call_id, name, content}` messages.
   *
   * TOOL_CALL spans in Mastra's Responses API flow do NOT carry a toolCallId
   * themselves — they only expose raw input/output, so positional correlation
   * with the parent MODEL_STEP's output.toolCalls list is the only reliable
   * way to reconstruct the ID.
   */
  private recordToolCallCompletion(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    if (!span.parentSpanId) return;
    const parentType = traceState.spanTypeById.get(span.parentSpanId);
    if (parentType !== MastraSpanType.MODEL_STEP) return;
    const bucket = traceState.toolOutputsByStep.get(span.parentSpanId);
    if (!bucket) return;
    bucket.push(span.output);
  }

  private pairModelStepToolCalls(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    const mgId = traceState.modelGenerationAncestor.get(span.id);
    if (!mgId) return;
    const mgState = traceState.modelGenerations.get(mgId);
    if (!mgState) return;
    const toolOutputs = traceState.toolOutputsByStep.get(span.id) ?? [];
    if (toolOutputs.length === 0) return;
    const output = span.output;
    const toolCalls =
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as { toolCalls?: unknown }).toolCalls
        : undefined;
    const toolCallsArr = Array.isArray(toolCalls) ? toolCalls : [];
    for (let i = 0; i < toolOutputs.length; i++) {
      const tc = toolCallsArr[i] as
        | { toolCallId?: unknown; toolName?: unknown }
        | undefined;
      const id =
        tc && typeof tc.toolCallId === "string" && tc.toolCallId.length > 0
          ? tc.toolCallId
          : "";
      const name =
        tc && typeof tc.toolName === "string" ? tc.toolName : undefined;
      mgState.toolOutputs.push({
        stepIndex: mgState.nextStepIndex,
        message: {
          role: "tool",
          tool_call_id: id,
          ...(name ? { name } : {}),
          content: stringifyToolResult(toolOutputs[i]),
        },
      });
    }
  }

  private recordModelStepCompletion(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): void {
    const mgId = traceState.modelGenerationAncestor.get(span.id);
    if (!mgId) return;
    const mgState = traceState.modelGenerations.get(mgId);
    if (!mgState) return;
    const assistant = modelStepOutputToAssistantTurn(span.output);
    if (!assistant) {
      mgState.nextStepIndex++;
      return;
    }
    mgState.steps.push({
      stepIndex: mgState.nextStepIndex,
      assistant,
    });
    mgState.nextStepIndex++;
  }

  private getOrCreateTraceState(traceId: string): TraceState {
    const existing = this.traceMap.get(traceId);
    if (existing) return existing;
    const created: TraceState = {
      spanPathById: new Map(),
      spanIdsPathById: new Map(),
      activeSpanIds: new Set(),
      modelGenerations: new Map(),
      modelGenerationAncestor: new Map(),
      toolOutputsByStep: new Map(),
      spanTypeById: new Map(),
    };
    this.traceMap.set(traceId, created);
    return created;
  }

  private ensureResourceAndScope(): void {
    if (this.resource && this.scope) return;
    this.resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.serviceName,
      [ATTR_SERVICE_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_NAME]: "@lmnr-ai/lmnr",
      [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
    });
    this.scope = { name: "lmnr.mastra", version: SDK_VERSION };
  }

  private convertSpanToOtel(
    span: MastraExportedSpan,
    traceState: TraceState,
  ): ReadableSpan {
    this.ensureResourceAndScope();
    const kind = getSpanKind(span.type);
    const startTime = dateToHrTime(span.startTime);
    const endTime = span.endTime ? dateToHrTime(span.endTime) : startTime;
    const duration = computeDuration(span.startTime, span.endTime);
    const traceId = normalizeTraceId(span.traceId);
    const spanId = normalizeSpanId(span.id);
    const { status, events } = buildStatusAndEvents(span, startTime);
    const spanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    const parentSpanContext = span.parentSpanId
      ? {
          traceId,
          spanId: normalizeSpanId(span.parentSpanId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
        }
      : undefined;
    const attributes = buildLaminarAttributes(span, traceState);
    const links: Link[] = [];
    const readable: ReadableSpan = {
      name: span.name,
      kind,
      spanContext: () => spanContext,
      parentSpanContext,
      startTime,
      endTime,
      status,
      attributes,
      links,
      events,
      duration,
      ended: true,
      resource: this.resource!,
      instrumentationScope: this.scope!,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    (readable as any).parentSpanId = span.parentSpanId
      ? normalizeSpanId(span.parentSpanId)
      : undefined;
    (readable as any).instrumentationLibrary = this.scope;
    return readable;
  }

  async flush(): Promise<void> {
    const processor = getSpanProcessor();
    if (processor) {
      try {
        await processor.forceFlush();
      } catch (error) {
        logger.debug(
          `[LaminarMastraExporter] Error flushing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    this.traceMap.clear();
    if (typeof super.shutdown === "function") {
      await super.shutdown();
    }
  }
}

const buildLaminarAttributes = (
  span: MastraExportedSpan,
  traceState: TraceState,
): Attributes => {
  const attributes: Attributes = {};
  const spanPath = traceState.spanPathById.get(span.id);
  const spanIdsPath = traceState.spanIdsPathById.get(span.id);
  if (spanPath) attributes[SPAN_PATH] = spanPath;
  if (spanIdsPath) attributes[SPAN_IDS_PATH] = spanIdsPath;

  attributes[SPAN_TYPE] = mapLaminarSpanType(span.type);
  attributes[SPAN_INSTRUMENTATION_SOURCE] = "javascript";
  attributes[SPAN_SDK_VERSION] = SDK_VERSION;
  attributes[SPAN_LANGUAGE_VERSION] = process.version;

  const sessionId = span.metadata?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    attributes[SESSION_ID] = sessionId;
  }
  const userId = span.metadata?.userId;
  if (typeof userId === "string" && userId.length > 0) {
    attributes[USER_ID] = userId;
  }

  if (span.metadata) {
    for (const [key, value] of Object.entries(span.metadata)) {
      if (
        key === "sessionId" ||
        key === "userId" ||
        value === undefined ||
        value === null
      ) {
        continue;
      }
      const attrValue = toLaminarAttributeValue(value);
      if (attrValue === undefined) continue;
      attributes[`${ASSOCIATION_PROPERTIES}.metadata.${key}`] = attrValue;
    }
  }

  if (span.isRootSpan && span.tags?.length) {
    attributes[`${ASSOCIATION_PROPERTIES}.tags`] = span.tags;
  }

  if (span.input !== undefined) {
    attributes[SPAN_INPUT] = serializeForLaminar(
      getLaminarSpanInput(span, traceState),
    );
  }
  if (span.output !== undefined) {
    attributes[SPAN_OUTPUT] = serializeForLaminar(getLaminarSpanOutput(span));
  }

  if (span.type === MastraSpanType.MODEL_GENERATION) {
    const modelAttrs = (span.attributes ??
      {}) as MastraModelGenerationAttributes;
    if (modelAttrs.provider) {
      attributes[GEN_AI_SYSTEM] = normalizeProvider(modelAttrs.provider);
    }
    if (modelAttrs.model) attributes[GEN_AI_REQUEST_MODEL] = modelAttrs.model;
    if (modelAttrs.responseModel) {
      attributes[GEN_AI_RESPONSE_MODEL] = modelAttrs.responseModel;
    }
    Object.assign(attributes, formatLaminarUsage(modelAttrs.usage));
  }

  return attributes;
};

const mapLaminarSpanType = (spanType: MastraSpanType): LaminarSpanType => {
  switch (spanType) {
    case MastraSpanType.MODEL_GENERATION:
    case MastraSpanType.MODEL_STEP:
      return "LLM";
    case MastraSpanType.TOOL_CALL:
    case MastraSpanType.MCP_TOOL_CALL:
      return "TOOL";
    default:
      return "DEFAULT";
  }
};

const formatLaminarUsage = (usage?: MastraUsageStats): Attributes => {
  if (!usage) return {};
  const out: Attributes = {};
  if (usage.inputTokens !== undefined)
    out[GEN_AI_USAGE_INPUT_TOKENS] = usage.inputTokens;
  if (usage.outputTokens !== undefined) {
    out[GEN_AI_USAGE_OUTPUT_TOKENS] = usage.outputTokens;
  }
  if (usage.inputDetails?.cacheWrite !== undefined) {
    out[GEN_AI_CACHE_WRITE_INPUT_TOKENS] = usage.inputDetails.cacheWrite;
  }
  if (usage.inputDetails?.cacheRead !== undefined) {
    out[GEN_AI_CACHE_READ_INPUT_TOKENS] = usage.inputDetails.cacheRead;
  }
  return out;
};

const serializeForLaminar = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const getLaminarSpanInput = (
  span: MastraExportedSpan,
  traceState: TraceState,
): unknown => {
  if (span.type === MastraSpanType.MODEL_GENERATION) {
    const input = span.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return input;
    const maybeMessages = (input as { messages?: unknown }).messages;
    const messages = Array.isArray(maybeMessages) ? maybeMessages : undefined;
    if (messages) {
      const normalized = normalizeAiSdkV5Messages(messages);
      return normalized ?? messages;
    }
    return input;
  }
  if (span.type === MastraSpanType.MODEL_STEP) {
    const reconstructed = reconstructModelStepInput(span, traceState);
    if (reconstructed) return reconstructed;
    const cleaned = cleanMastraNormalizedMessages(span.input);
    if (Array.isArray(cleaned)) {
      const normalized = normalizeAiSdkV5Messages(cleaned);
      return normalized ?? cleaned;
    }
    return cleaned;
  }
  return span.input;
};

/**
 * Rebuild the MODEL_STEP input from sibling span state rather than trusting
 * Mastra's stored `span.input`. Mastra's `@mastra/observability` runs
 * provider request bodies through `normalizeMessages`, which collapses any
 * non-`{role,content}` entry (OpenAI Responses API `function_call` /
 * `function_call_output` items) into `{role:"user", content:""}` — losing the
 * tool-call payload entirely.
 *
 * Reconstruction uses:
 *   - `initialMessages`   (from MODEL_GENERATION input — prompt + history)
 *   - `steps[].assistant` (from each prior MODEL_STEP's output — tool requests)
 *   - `toolOutputs`       (from TOOL_CALL span outputs — tool results)
 *
 * Steps/toolOutputs earlier than this step's index are interleaved in order:
 *   initial… → assistant(step0) → tool(step0 results) → assistant(step1) → …
 */
const reconstructModelStepInput = (
  span: MastraExportedSpan,
  traceState: TraceState,
): unknown[] | null => {
  const mgId = traceState.modelGenerationAncestor.get(span.id);
  if (!mgId) return null;
  const mgState = traceState.modelGenerations.get(mgId);
  if (!mgState) return null;
  const thisStepIndex = mgState.nextStepIndex; // not yet recorded — this is its slot
  const initial = mgState.initialMessages ?? [];
  const normalizedInitial = Array.isArray(initial)
    ? (normalizeAiSdkV5Messages(initial) ?? initial)
    : [];
  // First step: just the initial messages. No tool history to weave in.
  if (thisStepIndex === 0) {
    return normalizedInitial.length > 0 ? normalizedInitial : null;
  }
  const out: unknown[] = [...normalizedInitial];
  for (let i = 0; i < thisStepIndex; i++) {
    const step = mgState.steps.find((s) => s.stepIndex === i);
    if (step) out.push(step.assistant);
    const toolsForStep = mgState.toolOutputs.filter((t) => t.stepIndex === i);
    for (const t of toolsForStep) out.push(t.message);
  }
  return out;
};

const extractInitialMessages = (input: unknown): unknown[] | null => {
  if (!input) return null;
  if (Array.isArray(input)) return input;
  if (typeof input !== "object") return null;
  const maybeMessages = (input as { messages?: unknown }).messages;
  return Array.isArray(maybeMessages) ? maybeMessages : null;
};

/**
 * Convert a MODEL_STEP's `output` (AI SDK shape — `{text, toolCalls, object, …}`)
 * into an OpenAI-compatible assistant turn.
 *
 * Returns `null` if the output doesn't look like a model generation result —
 * then the step is treated as having no reconstructed assistant turn.
 */
const modelStepOutputToAssistantTurn = (
  output: unknown,
): OpenAIAssistantTurn | null => {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return null;
  const obj = output as {
    text?: unknown;
    toolCalls?: unknown;
    object?: unknown;
  };
  const turn: OpenAIAssistantTurn = { role: "assistant", content: null };
  if (typeof obj.text === "string" && obj.text.length > 0) {
    turn.content = obj.text;
  } else if (obj.object !== undefined) {
    turn.content =
      typeof obj.object === "string" ? obj.object : JSON.stringify(obj.object);
  }
  const toolCalls = Array.isArray(obj.toolCalls)
    ? obj.toolCalls
        .map(aiSdkV5ToolCallToOpenAI)
        .filter(
          (c): c is NonNullable<ReturnType<typeof aiSdkV5ToolCallToOpenAI>> =>
            c !== null,
        )
    : [];
  if (toolCalls.length > 0) turn.tool_calls = toolCalls;
  // Only emit an assistant turn if there's something to show.
  if (turn.content === null && !turn.tool_calls) return null;
  return turn;
};

const stringifyToolResult = (output: unknown): string => {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && !Array.isArray(output)) {
    const o = output as { type?: unknown; value?: unknown; text?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
    if (typeof o.text === "string") return o.text;
  }
  return serializeForLaminar(output);
};

const getLaminarSpanOutput = (span: MastraExportedSpan): unknown => {
  if (span.type !== MastraSpanType.MODEL_GENERATION) return span.output;
  const output = span.output;
  if (!output || typeof output !== "object" || Array.isArray(output))
    return output;
  const obj = output as {
    text?: unknown;
    toolCalls?: unknown;
    object?: unknown;
  };
  const assistant: Record<string, unknown> = { role: "assistant" };
  if (typeof obj.text === "string") {
    assistant.content = obj.text;
  } else if (obj.object !== undefined) {
    assistant.content =
      typeof obj.object === "string" ? obj.object : JSON.stringify(obj.object);
  } else {
    assistant.content = null;
  }
  const toolCalls = Array.isArray(obj.toolCalls)
    ? obj.toolCalls.map(aiSdkV5ToolCallToOpenAI).filter(Boolean)
    : [];
  if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
  return [assistant];
};

/**
 * Mastra hands us assistant/tool turns in AI SDK v5 `ModelMessage` shape:
 *   {role:'assistant', content: [{type:'text'}, {type:'tool-call', toolCallId, toolName, input}]}
 *   {role:'tool', content: [{type:'tool-result', toolCallId, toolName, output}]}
 *
 * Laminar's frontend renderer selects a parser from the payload shape. The AI-SDK
 * v5 shape matches none of the specific parsers (OpenAI, Anthropic, Gemini,
 * LangChain, GenAI semconv), so it falls through to the generic converter, which
 * stringifies tool-call/tool-result parts and hides tool history after the first
 * step. Convert to OpenAI Chat Completions shape here — it's the most
 * round-trippable format for Laminar's UI.
 *
 * Returns `null` if the array does not look like AI SDK v5 ModelMessages, so the
 * caller can fall back to the raw payload.
 */
const normalizeAiSdkV5Messages = (messages: unknown[]): unknown[] | null => {
  if (messages.length === 0) return null;
  if (!messages.some(looksLikeAiSdkV5Message)) return null;
  const out: unknown[] = [];
  for (const m of messages) {
    const converted = aiSdkV5MessageToOpenAI(m);
    if (Array.isArray(converted)) {
      for (const c of converted) out.push(c);
    } else {
      out.push(converted);
    }
  }
  return out;
};

const looksLikeAiSdkV5Message = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as { role?: unknown; content?: unknown };
  if (typeof m.role !== "string") return false;
  if (!Array.isArray(m.content)) return false;
  return m.content.some((part: unknown) => {
    if (!part || typeof part !== "object") return false;
    const t = (part as { type?: unknown }).type;
    return t === "tool-call" || t === "tool-result" || t === "text";
  });
};

const aiSdkV5MessageToOpenAI = (msg: unknown): unknown => {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as { role?: string; content?: unknown };
  const role = m.role;

  if (role === "tool" && Array.isArray(m.content)) {
    // AI SDK v5 groups tool results into a single `role:'tool'` message; OpenAI
    // Chat Completions requires one message per tool_call_id. Split them.
    return m.content.map((part) => {
      const p = part as {
        toolCallId?: unknown;
        toolName?: unknown;
        output?: unknown;
      };
      return {
        role: "tool",
        tool_call_id: typeof p.toolCallId === "string" ? p.toolCallId : "",
        ...(typeof p.toolName === "string" && p.toolName.length > 0
          ? { name: p.toolName }
          : {}),
        content: aiSdkV5ToolOutputToString(p.output),
      };
    });
  }

  if (role === "assistant" && Array.isArray(m.content)) {
    const textChunks: string[] = [];
    const toolCalls: unknown[] = [];
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const t = p.type;
      if (t === "text" && typeof p.text === "string") {
        textChunks.push(p.text);
      } else if (t === "tool-call") {
        const oc = aiSdkV5ToolCallToOpenAI(p);
        if (oc) toolCalls.push(oc);
      }
    }
    const assistant: Record<string, unknown> = { role: "assistant" };
    assistant.content = textChunks.length > 0 ? textChunks.join("") : null;
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    return assistant;
  }

  if ((role === "user" || role === "system") && Array.isArray(m.content)) {
    // Collapse a text-only user/system message to a plain string so it renders
    // identically to Chat Completions. Mixed content (text + images/files) stays
    // as an array — `{type:'text', text}` and `{type:'image', image}` parts are
    // already close to OpenAI's shape.
    const allText = m.content.every(
      (p) =>
        p && typeof p === "object" && (p as { type?: unknown }).type === "text",
    );
    if (allText) {
      const text = m.content
        .map((p) => (p as { text?: unknown }).text)
        .filter((t) => typeof t === "string")
        .join("");
      return { role, content: text };
    }
    return { role, content: m.content };
  }

  return msg;
};

const aiSdkV5ToolCallToOpenAI = (
  part: unknown,
): {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
} | null => {
  if (!part || typeof part !== "object") return null;
  const p = part as {
    toolCallId?: unknown;
    toolName?: unknown;
    input?: unknown;
    args?: unknown;
    type?: unknown;
  };
  const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
  const name = typeof p.toolName === "string" ? p.toolName : "";
  const rawArgs = p.input !== undefined ? p.input : p.args;
  const args =
    typeof rawArgs === "string"
      ? rawArgs
      : rawArgs === undefined
        ? ""
        : JSON.stringify(rawArgs);
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
};

const aiSdkV5ToolOutputToString = (output: unknown): string => {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  // AI SDK v5 tool outputs may be `{type: 'text', value: '...'}` or
  // `{type: 'json', value: {...}}`; collapse to a plain string.
  if (typeof output === "object" && !Array.isArray(output)) {
    const o = output as { type?: unknown; value?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
    if (o.value !== undefined) {
      return typeof o.value === "string"
        ? o.value
        : serializeForLaminar(o.value);
    }
  }
  return serializeForLaminar(output);
};

/**
 * Mastra's `extractStepInput` runs every item of the provider request body
 * through a `normalizeMessages` helper that assumes each entry is a chat
 * message with `role` + `content`. For OpenAI's Responses API, request bodies
 * instead use `body.input: [...]` containing non-message items like
 *   - `{ type: "function_call", call_id, name, arguments, id }`
 *   - `{ type: "function_call_output", call_id, output }`
 * Those have no `role` and no `content`, so Mastra's normalizer silently
 * coerces them to `{ role: "user", content: "" }`. The result is a `MODEL_STEP`
 * span input that shows spurious empty user turns after every tool round-trip.
 *
 * We can't recover the original tool-call payload here (Mastra already
 * discarded it by the time the exported span reaches us), but we can drop the
 * useless empty user placeholders so the span input at least matches the real
 * prompt shape. Track: upstream fix in `@mastra/observability` normalizer.
 */
const cleanMastraNormalizedMessages = (input: unknown): unknown => {
  if (!Array.isArray(input)) return input;
  const filtered = input.filter((entry) => !isMastraEmptyUserArtifact(entry));
  return filtered.length === input.length ? input : filtered;
};

const isMastraEmptyUserArtifact = (entry: unknown): boolean => {
  if (!entry || typeof entry !== "object") return false;
  const obj = entry as Record<string, unknown>;
  if (Object.keys(obj).length !== 2) return false;
  return obj.role === "user" && obj.content === "";
};

const toLaminarAttributeValue = (
  value: unknown,
): Attributes[string] | undefined => {
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
  return serializeForLaminar(value);
};

const dateToHrTime = (date: Date): HrTime => {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return [seconds, nanoseconds];
};

const computeDuration = (start: Date, end?: Date): HrTime => {
  if (!end) return [0, 0];
  const diffMs = end.getTime() - start.getTime();
  return [Math.floor(diffMs / 1000), (diffMs % 1000) * 1_000_000];
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
    events.push({
      name: "exception",
      attributes: {
        "exception.message": span.errorInfo.message,
        "exception.type": "Error",
        ...(span.errorInfo.details?.stack && {
          "exception.stacktrace": span.errorInfo.details.stack,
        }),
      },
      time: defaultTime,
      droppedAttributesCount: 0,
    });
    return { status, events };
  }
  return { status: { code: SpanStatusCode.OK }, events };
};

const getSpanKind = (type: MastraSpanType): SpanKind => {
  switch (type) {
    case MastraSpanType.MODEL_GENERATION:
    case MastraSpanType.MCP_TOOL_CALL:
      return SpanKind.CLIENT;
    default:
      return SpanKind.INTERNAL;
  }
};

// Strip anything that isn't a hex digit. Mastra's own generators always emit
// hex, but bridges (e.g. the AI-SDK bridge) or user-supplied ids can round-trip
// through UUID-formatted strings with dashes. OTel trace/span ids must be pure
// hex, so we defensively normalize before use.
const toHex = (value: string): string => {
  let id = value.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  return id.replace(/[^0-9a-f]/g, "");
};

const normalizeTraceId = (traceId: string): string =>
  toHex(traceId).padStart(32, "0").slice(-32);

const normalizeSpanId = (spanId: string): string =>
  toHex(spanId).padStart(16, "0").slice(-16);

const normalizeProvider = (provider: string): string =>
  provider.split(".").shift()?.toLowerCase().trim() ||
  provider.toLowerCase().trim();
