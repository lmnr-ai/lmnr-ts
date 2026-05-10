// Vercel AI SDK v7 telemetry integration.
//
// v7 replaces the v6 `experimental_telemetry: { tracer }` OTel-span-based
// design with a plain `Telemetry` interface — 16 optional lifecycle callbacks
// plus an `executeTool` wrapper that lets integrations propagate context into
// tool execution (required for sub-agent nesting).
//
// Span hierarchy we build:
//   <generateText|streamText> (DEFAULT)
//     ├─ <step 0>              (DEFAULT)
//     │   ├─ <llm call>        (LLM)
//     │   ├─ <tool: X>         (TOOL) — flat sibling, not a child of the LLM
//     │   ├─ <tool: Y>         (TOOL)
//     ├─ <step 1>
//     │   ├─ <llm call>        (LLM)
//     │   ...
//
// For embed / embedMany / rerank we create a single LLM span directly under
// the operation span — there are no step or tool spans.
//
// Attribute strategy: hybrid. Emit both `ai.*` (what v6 wrote) and `gen_ai.*`
// (OTel GenAI semconv). Laminar's backend parser reads both families.
//
// Sub-agent nesting works because `executeTool` wraps the tool's execute in
// an OTel context that has the tool span set as the active span. Nested
// `generateText` calls pick that up via `LaminarContextManager.getContext()`
// which falls through to `trace.getActiveSpan()` / the Laminar ALS stack.

import * as diagnosticsChannel from "node:diagnostics_channel";

import {
  type Context,
  context as contextApi,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

import { getTracer } from "../../tracing";
import {
  LaminarAttributes,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
} from "../../tracing/attributes";
import { LaminarContextManager } from "../../tracing/context";

/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * The AI SDK v7 diagnostics channel name. Every lifecycle event fires
 * `{ type, event }` through this channel.
 */
export const AI_SDK_TELEMETRY_DIAGNOSTIC_CHANNEL = "aisdk:telemetry";

interface OperationState {
  span: Span;
  ctx: Context;
  operationId?: string;
  provider?: string;
  modelId?: string;
}

interface StepState {
  span: Span;
  ctx: Context;
  stepNumber: number;
}

interface LlmState {
  span: Span;
  textDeltas: string[];
}

interface ToolState {
  span: Span;
  ctx: Context;
  callId: string;
}

const stepKey = (callId: string, stepNumber: number) =>
  `${callId}:${stepNumber}`;

const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const normalizeProvider = (
  provider: string | undefined,
): string | undefined => {
  if (!provider) return undefined;
  const head = provider.split(".").shift();
  return (
    head?.toLowerCase().trim() || provider.toLowerCase().trim() || undefined
  );
};

const applyUsage = (attributes: Record<string, any>, usage: any): void => {
  if (!usage || typeof usage !== "object") return;
  if (typeof usage.inputTokens === "number") {
    attributes[LaminarAttributes.INPUT_TOKEN_COUNT] = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    attributes[LaminarAttributes.OUTPUT_TOKEN_COUNT] = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    attributes[LaminarAttributes.TOTAL_TOKEN_COUNT] = usage.totalTokens;
  } else if (
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number"
  ) {
    attributes[LaminarAttributes.TOTAL_TOKEN_COUNT] =
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  if (typeof usage.reasoningTokens === "number") {
    attributes["gen_ai.usage.reasoning_tokens"] = usage.reasoningTokens;
  } else if (typeof usage.outputTokenDetails?.reasoningTokens === "number") {
    attributes["gen_ai.usage.reasoning_tokens"] =
      usage.outputTokenDetails.reasoningTokens;
  }
  if (typeof usage.cachedInputTokens === "number") {
    attributes["gen_ai.usage.cache_read_input_tokens"] =
      usage.cachedInputTokens;
  } else if (typeof usage.inputTokenDetails?.cacheReadTokens === "number") {
    attributes["gen_ai.usage.cache_read_input_tokens"] =
      usage.inputTokenDetails.cacheReadTokens;
  }
  if (typeof usage.inputTokenDetails?.cacheWriteTokens === "number") {
    attributes["gen_ai.usage.cache_creation_input_tokens"] =
      usage.inputTokenDetails.cacheWriteTokens;
  }
};

// Convert a StandardizedPrompt-shaped object (`system` + `messages`) to an
// array of `ModelMessage`-like entries. Laminar's backend parses
// `ai.prompt.messages` as an array of AI SDK messages.
const standardizedPromptToMessages = (event: {
  system?: any;
  messages?: any[];
}): any[] => {
  const messages: any[] = [];
  const sys = event.system;
  if (typeof sys === "string" && sys.length > 0) {
    messages.push({ role: "system", content: sys });
  } else if (Array.isArray(sys)) {
    for (const m of sys) messages.push(m);
  } else if (sys && typeof sys === "object") {
    messages.push(sys);
  }
  if (Array.isArray(event.messages)) {
    for (const m of event.messages) messages.push(m);
  }
  return messages;
};

// Build a concise `ai.response.toolCalls`-shaped array from v7 `toolCalls`.
const normalizeToolCalls = (toolCalls: any[] | undefined): any[] => {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => ({
    toolCallType: "function",
    toolCallId: tc?.toolCallId,
    toolName: tc?.toolName,
    args:
      typeof tc?.input === "string" ? tc.input : serializeJSON(tc?.input ?? {}),
  }));
};

const extractTextFromContent = (content: any[] | undefined): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
};

const extractReasoningFromContent = (content: any[] | undefined): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
};

export interface LaminarTelemetryOptions {
  /**
   * When true, record prompt messages and response content on spans.
   * Defaults to true.
   */
  recordInputs?: boolean;
  recordOutputs?: boolean;
}

/**
 * Laminar's implementation of the AI SDK v7 `Telemetry` interface.
 *
 * Shape matches `ai`'s exported `Telemetry` (v7). Constructing this class
 * directly depends only on OTel and Laminar internals — we do NOT import the
 * `Telemetry` interface from `ai` so users can pick up the integration even
 * when they are on a narrower `ai` version that doesn't export it yet.
 */
export class LaminarTelemetry {
  private readonly recordInputs: boolean;
  private readonly recordOutputs: boolean;

  // Root operation span (one per generateText/streamText/generateObject/
  // streamObject/embed/embedMany/rerank call), keyed by AI SDK `callId`.
  private readonly operationByCallId = new Map<string, OperationState>();
  // Step span (one per LLM invocation within a text-generation operation),
  // keyed by `${callId}:${stepNumber}`.
  private readonly stepByKey = new Map<string, StepState>();
  // LLM child span under the step. Same key shape as stepByKey.
  private readonly llmByKey = new Map<string, LlmState>();
  // Tool spans keyed by toolCallId (AI SDK guarantees uniqueness per run).
  private readonly toolByCallId = new Map<string, ToolState>();
  // Active streaming step per callId, set by `ai.stream.firstChunk` and
  // cleared by `ai.stream.finish`. Used to route `text-delta` chunks to the
  // right LLM span — individual text-delta chunks don't carry callId or
  // stepNumber themselves.
  private readonly activeStreamStepByCallId = new Map<string, number>();

  constructor(options: LaminarTelemetryOptions = {}) {
    this.recordInputs = options.recordInputs ?? true;
    this.recordOutputs = options.recordOutputs ?? true;
  }

  // ------------------------------------------------------------------
  // operation-level: generateText / streamText / generateObject / streamObject
  // ------------------------------------------------------------------

  onStart = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const operationId: string = event?.operationId ?? "ai.unknown";
    const parentCtx = LaminarContextManager.getContext();
    const tracer = getTracer();
    const span = tracer.startSpan(
      operationId,
      { kind: SpanKind.CLIENT },
      parentCtx,
    );
    const spanCtx = trace.setSpan(parentCtx, span);

    span.setAttribute(SPAN_TYPE, "DEFAULT");
    if (typeof event.operationId === "string") {
      span.setAttribute("ai.operation", event.operationId);
    }
    if (typeof event.provider === "string") {
      const provider = normalizeProvider(event.provider);
      if (provider) span.setAttribute(LaminarAttributes.PROVIDER, provider);
    }
    if (typeof event.modelId === "string") {
      span.setAttribute(LaminarAttributes.REQUEST_MODEL, event.modelId);
      span.setAttribute("ai.model.id", event.modelId);
    }
    if (typeof event.functionId === "string") {
      span.setAttribute("ai.functionId", event.functionId);
    }

    // Classify embed / embedMany / rerank as LLM spans directly, since there
    // are no step or llm-call child spans for these.
    const opKind = operationId;
    const isEmbedOrRerank =
      opKind === "ai.embed" ||
      opKind === "ai.embedMany" ||
      opKind === "ai.rerank";
    if (isEmbedOrRerank) {
      span.setAttribute(SPAN_TYPE, "LLM");
    }

    if (this.recordInputs) {
      // generate/stream variants carry StandardizedPrompt (system + messages);
      // embed carries `value`; rerank carries `documents` + `query`.
      if (Array.isArray(event.messages) || event.system !== undefined) {
        const msgs = standardizedPromptToMessages(event);
        if (msgs.length > 0) {
          const serialized = serializeJSON(msgs);
          span.setAttribute("ai.prompt.messages", serialized);
          span.setAttribute(SPAN_INPUT, serialized);
        }
      } else if (event.value !== undefined) {
        span.setAttribute(SPAN_INPUT, serializeJSON(event.value));
      } else if (event.query !== undefined || event.documents !== undefined) {
        span.setAttribute(
          SPAN_INPUT,
          serializeJSON({ query: event.query, documents: event.documents }),
        );
      }
    }

    this.operationByCallId.set(callId, {
      span,
      ctx: spanCtx,
      operationId,
      provider: event.provider,
      modelId: event.modelId,
    });
  };

  onStepStart = (event: any): void => {
    const callId: string | undefined = event?.callId;
    const stepNumber: number = event?.stepNumber ?? 0;
    if (!callId) return;
    const op = this.operationByCallId.get(callId);
    if (!op) return;
    const tracer = getTracer();
    const span = tracer.startSpan(
      `ai.step ${stepNumber}`,
      { kind: SpanKind.CLIENT },
      op.ctx,
    );
    const spanCtx = trace.setSpan(op.ctx, span);
    span.setAttribute(SPAN_TYPE, "DEFAULT");
    span.setAttribute("ai.step.number", stepNumber);

    if (this.recordInputs) {
      const msgs = standardizedPromptToMessages(event);
      if (msgs.length > 0) {
        const serialized = serializeJSON(msgs);
        span.setAttribute("ai.prompt.messages", serialized);
        span.setAttribute(SPAN_INPUT, serialized);
      }
    }

    this.stepByKey.set(stepKey(callId, stepNumber), {
      span,
      ctx: spanCtx,
      stepNumber,
    });
  };

  onLanguageModelCallStart = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    // LLM calls attach either to a step (generateText/streamText) or directly
    // to the operation span (generateObject/streamObject). Pick whichever
    // step matches the operation's current latest stepNumber when we don't
    // have an explicit stepNumber on the event.
    const step = this.findLatestStep(callId);
    const parentCtx = step?.ctx ?? this.operationByCallId.get(callId)?.ctx;
    if (!parentCtx) return;
    const stepNumber = step?.stepNumber ?? 0;

    const tracer = getTracer();
    const span = tracer.startSpan(
      `ai.llm ${event.provider ?? ""}:${event.modelId ?? ""}`,
      { kind: SpanKind.CLIENT },
      parentCtx,
    );
    span.setAttribute(SPAN_TYPE, "LLM");
    if (typeof event.provider === "string") {
      const provider = normalizeProvider(event.provider);
      if (provider) span.setAttribute(LaminarAttributes.PROVIDER, provider);
      span.setAttribute("ai.model.provider", event.provider);
    }
    if (typeof event.modelId === "string") {
      span.setAttribute(LaminarAttributes.REQUEST_MODEL, event.modelId);
      span.setAttribute("ai.model.id", event.modelId);
    }
    if (this.recordInputs) {
      const msgs = standardizedPromptToMessages(event);
      if (msgs.length > 0) {
        const serialized = serializeJSON(msgs);
        span.setAttribute("ai.prompt.messages", serialized);
        span.setAttribute(SPAN_INPUT, serialized);
      }
    }

    this.llmByKey.set(stepKey(callId, stepNumber), {
      span,
      textDeltas: [],
    });
  };

  onLanguageModelCallEnd = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const step = this.findLatestStep(callId);
    const stepNumber = step?.stepNumber ?? 0;
    const llm = this.llmByKey.get(stepKey(callId, stepNumber));
    if (!llm) return;

    const span = llm.span;
    if (typeof event.provider === "string") {
      const provider = normalizeProvider(event.provider);
      if (provider) span.setAttribute(LaminarAttributes.PROVIDER, provider);
    }
    if (typeof event.modelId === "string") {
      span.setAttribute(LaminarAttributes.RESPONSE_MODEL, event.modelId);
    }
    if (typeof event.finishReason === "string") {
      span.setAttribute("gen_ai.response.finish_reason", event.finishReason);
      span.setAttribute("ai.response.finishReason", event.finishReason);
    }
    if (typeof event.responseId === "string") {
      span.setAttribute("gen_ai.response.id", event.responseId);
    }
    const usageAttrs: Record<string, any> = {};
    applyUsage(usageAttrs, event.usage);
    for (const [k, v] of Object.entries(usageAttrs)) {
      if (v !== undefined) span.setAttribute(k, v);
    }

    if (this.recordOutputs) {
      const content: any[] | undefined = Array.isArray(event.content)
        ? (event.content as any[])
        : undefined;
      const text = extractTextFromContent(content);
      const reasoningText = extractReasoningFromContent(content);
      const toolCallsRaw = content
        ? content.filter((p: any) => p && p.type === "tool-call")
        : [];
      const normalizedToolCalls = normalizeToolCalls(toolCallsRaw);

      if (text.length > 0) {
        span.setAttribute("ai.response.text", text);
        span.setAttribute(SPAN_OUTPUT, text);
      }
      if (normalizedToolCalls.length > 0) {
        span.setAttribute(
          "ai.response.toolCalls",
          serializeJSON(normalizedToolCalls),
        );
        if (text.length === 0) {
          span.setAttribute(SPAN_OUTPUT, serializeJSON(normalizedToolCalls));
        }
      }

      // OTel GenAI semconv `gen_ai.output.messages` — rendered by the Laminar
      // UI with a Thinking label when `type: "thinking"` is present.
      if (reasoningText.length > 0 || normalizedToolCalls.length > 0) {
        const parts: any[] = [];
        if (reasoningText.length > 0) {
          parts.push({ type: "thinking", content: reasoningText });
        }
        if (text.length > 0) {
          parts.push({ type: "text", content: text });
        }
        for (const tc of normalizedToolCalls) {
          let argsObj: unknown = tc.args;
          if (typeof argsObj === "string") {
            try {
              argsObj = JSON.parse(argsObj);
            } catch {
              // leave string — backend tolerates both
            }
          }
          parts.push({
            type: "tool_call",
            id: tc.toolCallId,
            name: tc.toolName,
            arguments: argsObj,
          });
        }
        if (parts.length > 0) {
          span.setAttribute(
            "gen_ai.output.messages",
            JSON.stringify([{ role: "assistant", parts }]),
          );
        }
      }
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.llmByKey.delete(stepKey(callId, stepNumber));
  };

  onChunk = (event: any): void => {
    const chunk = event?.chunk;
    if (!chunk || typeof chunk !== "object") return;
    // Only the lifecycle markers `ai.stream.firstChunk` / `ai.stream.finish`
    // carry `callId` + `stepNumber`; regular content chunks (`text-delta`,
    // `tool-call`, etc.) do not — they are plain `TextStreamPart` objects.
    // See AI SDK source `packages/ai/src/generate-text/stream-text.ts` for
    // the publish points. We therefore latch the active streaming step when
    // `firstChunk` fires and route subsequent text-delta chunks to it until
    // `finish` arrives.
    if (chunk.type === "ai.stream.firstChunk") {
      if (
        typeof chunk.callId === "string" &&
        typeof chunk.stepNumber === "number"
      ) {
        this.activeStreamStepByCallId.set(chunk.callId, chunk.stepNumber);
      }
      return;
    }
    if (chunk.type === "ai.stream.finish") {
      if (typeof chunk.callId === "string") {
        this.activeStreamStepByCallId.delete(chunk.callId);
      }
      return;
    }
    if (chunk.type !== "text-delta") return;
    if (typeof chunk.text !== "string" || chunk.text.length === 0) return;
    // Content chunks carry no callId. When exactly one stream is active we
    // can route the delta unambiguously; with 2+ concurrent streams sharing
    // the same LaminarTelemetry instance the owner is ambiguous and naive
    // LIFO would misattribute A's chunks to B after B's firstChunk. In that
    // case skip accumulation — the buffered-deltas path is only a fallback
    // for when onLanguageModelCallEnd doesn't fire; on the normal path we
    // read text from `event.content` which is correctly scoped per call.
    if (this.activeStreamStepByCallId.size !== 1) return;
    const [callId, stepNumber] = this.activeStreamStepByCallId
      .entries()
      .next().value!;
    const llm = this.llmByKey.get(stepKey(callId, stepNumber));
    if (!llm) return;
    llm.textDeltas.push(chunk.text);
  };

  onStepFinish = (event: any): void => {
    const callId: string | undefined = event?.callId;
    const stepNumber: number = event?.stepNumber ?? 0;
    if (!callId) return;
    const key = stepKey(callId, stepNumber);
    const step = this.stepByKey.get(key);
    if (!step) return;

    // Ensure the LLM span for this step is closed, even if the provider
    // skipped `onLanguageModelCallEnd` (e.g. an error surfaced via onError).
    const llm = this.llmByKey.get(key);
    if (llm) {
      // Flush any buffered stream deltas as the text output if we haven't
      // already set one via onLanguageModelCallEnd. Mirror that path's
      // attribute writes (ai.response.text + SPAN_OUTPUT) — Laminar's backend
      // reads SPAN_OUTPUT (`lmnr.span.output`) to render the span's output
      // panel, so setting only ai.response.text would leave the LLM span
      // visually empty.
      if (this.recordOutputs && llm.textDeltas.length > 0) {
        const bufferedText = llm.textDeltas.join("");
        llm.span.setAttribute("ai.response.text", bufferedText);
        llm.span.setAttribute(SPAN_OUTPUT, bufferedText);
      }
      llm.span.end();
      this.llmByKey.delete(key);
    }

    // Emit per-step usage + finish reason on the step span too, so a step
    // that was interrupted mid-stream still reports correct totals.
    const attrs: Record<string, any> = {};
    applyUsage(attrs, event.usage);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) step.span.setAttribute(k, v);
    }
    if (typeof event.finishReason === "string") {
      step.span.setAttribute(
        "gen_ai.response.finish_reason",
        event.finishReason,
      );
      step.span.setAttribute("ai.response.finishReason", event.finishReason);
    }
    if (this.recordOutputs) {
      const outputPayload: Record<string, unknown> = {};
      if (typeof event.text === "string" && event.text.length > 0) {
        outputPayload.text = event.text;
        step.span.setAttribute("ai.response.text", event.text);
      }
      const normalizedToolCalls = normalizeToolCalls(event.toolCalls);
      if (normalizedToolCalls.length > 0) {
        outputPayload.toolCalls = normalizedToolCalls;
        step.span.setAttribute(
          "ai.response.toolCalls",
          serializeJSON(normalizedToolCalls),
        );
      }
      if (Object.keys(outputPayload).length > 0) {
        step.span.setAttribute(SPAN_OUTPUT, serializeJSON(outputPayload));
      }
    }

    step.span.setStatus({ code: SpanStatusCode.OK });
    step.span.end();
    this.stepByKey.delete(key);
  };

  // ------------------------------------------------------------------
  // object-generation (generateObject / streamObject)
  //
  // These callbacks fire ONLY from generateObject / streamObject (which call
  // model.doGenerate / doStream directly) — they do NOT overlap with
  // onLanguageModelCall* (which fire only from generateText / streamText via
  // stream-language-model-call.ts). So keying the LLM span under
  // stepKey(callId, 0) is safe — there is no onLanguageModelCallStart/End pair
  // for the same callId that would collide on the same map entry.
  // ------------------------------------------------------------------

  onObjectStepStart = (event: any): void => {
    // generateObject/streamObject emit step 0 with no StandardizedPrompt at
    // step-start time — just map to an LLM span directly under the operation.
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const op = this.operationByCallId.get(callId);
    if (!op) return;
    const tracer = getTracer();
    const span = tracer.startSpan(
      `ai.llm ${event.provider ?? ""}:${event.modelId ?? ""}`,
      { kind: SpanKind.CLIENT },
      op.ctx,
    );
    span.setAttribute(SPAN_TYPE, "LLM");
    if (typeof event.provider === "string") {
      const provider = normalizeProvider(event.provider);
      if (provider) span.setAttribute(LaminarAttributes.PROVIDER, provider);
      span.setAttribute("ai.model.provider", event.provider);
    }
    if (typeof event.modelId === "string") {
      span.setAttribute(LaminarAttributes.REQUEST_MODEL, event.modelId);
      span.setAttribute("ai.model.id", event.modelId);
    }
    this.llmByKey.set(stepKey(callId, 0), { span, textDeltas: [] });
  };

  onObjectStepFinish = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const llm = this.llmByKey.get(stepKey(callId, 0));
    if (!llm) return;
    if (typeof event.finishReason === "string") {
      llm.span.setAttribute(
        "gen_ai.response.finish_reason",
        event.finishReason,
      );
      llm.span.setAttribute("ai.response.finishReason", event.finishReason);
    }
    // GenerateObjectStepEndEvent.response carries { id, modelId, ... } — mirror
    // onLanguageModelCallEnd by emitting gen_ai.response.model +
    // gen_ai.response.id so model-routing / cost dashboards see the actual
    // response model for object-gen calls too.
    const response = event?.response;
    if (response && typeof response === "object") {
      if (typeof response.modelId === "string") {
        llm.span.setAttribute(
          LaminarAttributes.RESPONSE_MODEL,
          response.modelId,
        );
      }
      if (typeof response.id === "string") {
        llm.span.setAttribute("gen_ai.response.id", response.id);
      }
    }
    const attrs: Record<string, any> = {};
    applyUsage(attrs, event.usage);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) llm.span.setAttribute(k, v);
    }
    if (this.recordOutputs && typeof event.objectText === "string") {
      llm.span.setAttribute("ai.response.text", event.objectText);
      llm.span.setAttribute(SPAN_OUTPUT, event.objectText);
    }
    llm.span.setStatus({ code: SpanStatusCode.OK });
    llm.span.end();
    this.llmByKey.delete(stepKey(callId, 0));
  };

  // ------------------------------------------------------------------
  // tool execution — spans are flat siblings of the LLM span under the step
  // ------------------------------------------------------------------

  onToolExecutionStart = (event: any): void => {
    const callId: string | undefined = event?.callId;
    const toolCall = event?.toolCall;
    const toolCallId: string | undefined = toolCall?.toolCallId;
    const toolName: string | undefined = toolCall?.toolName;
    if (!callId || !toolCallId) return;

    // Parent the tool span under the current step, not the LLM span. LLM and
    // tool spans are flat siblings under the step.
    const step = this.findLatestStep(callId);
    const parentCtx = step?.ctx ?? this.operationByCallId.get(callId)?.ctx;
    if (!parentCtx) return;

    const tracer = getTracer();
    const span = tracer.startSpan(
      `ai.tool ${toolName ?? "unknown"}`,
      { kind: SpanKind.CLIENT },
      parentCtx,
    );
    const spanCtx = trace.setSpan(parentCtx, span);
    span.setAttribute(SPAN_TYPE, "TOOL");
    if (toolName) span.setAttribute("ai.toolCall.name", toolName);
    span.setAttribute("ai.toolCall.id", toolCallId);
    if (this.recordInputs && toolCall?.input !== undefined) {
      const serialized = serializeJSON(toolCall.input);
      span.setAttribute("ai.toolCall.args", serialized);
      span.setAttribute(SPAN_INPUT, serialized);
    }
    this.toolByCallId.set(toolCallId, { span, ctx: spanCtx, callId });
  };

  onToolExecutionEnd = (event: any): void => {
    const toolCallId: string | undefined = event?.toolCall?.toolCallId;
    if (!toolCallId) return;
    const tool = this.toolByCallId.get(toolCallId);
    if (!tool) return;

    if (typeof event.durationMs === "number") {
      tool.span.setAttribute("ai.toolCall.durationMs", event.durationMs);
    }

    const output = event?.toolOutput;
    if (output && typeof output === "object") {
      if (output.type === "tool-error") {
        const err = output.error;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : serializeJSON(err);
        tool.span.recordException(
          err instanceof Error ? err : new Error(message),
        );
        tool.span.setStatus({ code: SpanStatusCode.ERROR, message });
        if (this.recordOutputs) {
          tool.span.setAttribute(SPAN_OUTPUT, message);
          tool.span.setAttribute("ai.toolCall.error", message);
        }
      } else if (output.type === "tool-result") {
        if (this.recordOutputs && output.output !== undefined) {
          const serialized = serializeJSON(output.output);
          tool.span.setAttribute("ai.toolCall.result", serialized);
          tool.span.setAttribute(SPAN_OUTPUT, serialized);
        }
        tool.span.setStatus({ code: SpanStatusCode.OK });
      }
    } else {
      tool.span.setStatus({ code: SpanStatusCode.OK });
    }

    tool.span.end();
    this.toolByCallId.delete(toolCallId);
  };

  /**
   * `executeTool` is v7's context-propagation hook. The AI SDK runs the
   * tool's `execute` function inside whatever we return, so by entering a
   * context that has the tool span set as the active span, any nested
   * `generateText`/`streamText` call inside the tool will be reparented
   * under the TOOL span (sub-agent nesting).
   */
  executeTool = <T>(options: {
    callId: string;
    toolCallId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> => {
    const tool = this.toolByCallId.get(options.toolCallId);
    if (!tool) return options.execute();
    // Push onto both the OTel active context AND the Laminar ALS stack so
    // *any* child — standard OTel instrumentation (`trace.getActiveSpan`) and
    // Laminar-aware calls (`LaminarContextManager.getContext`) — can see it.
    return contextApi.with(tool.ctx, () => {
      const currentStack = LaminarContextManager.getContextStack();
      return LaminarContextManager.runWithIsolatedContext(
        [...currentStack, tool.ctx],
        () => options.execute(),
      );
    });
  };

  // ------------------------------------------------------------------
  // embed / rerank — single LLM span, closed directly on finish
  // ------------------------------------------------------------------

  onEmbedStart = (event: any): void => {
    // Individual doEmbed invocation — we don't create a separate span for
    // each, the operation-level `onStart` already created an LLM span.
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const op = this.operationByCallId.get(callId);
    if (!op) return;
    if (typeof event.modelId === "string") {
      op.span.setAttribute(LaminarAttributes.REQUEST_MODEL, event.modelId);
    }
  };

  onEmbedFinish = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const op = this.operationByCallId.get(callId);
    if (!op) return;
    const attrs: Record<string, any> = {};
    applyUsage(attrs, event.usage);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) op.span.setAttribute(k, v);
    }
  };

  onRerankStart = (): void => {
    // onStart already created the LLM span for ai.rerank. Nothing to do —
    // documents/query are already recorded.
  };

  onRerankFinish = (): void => {
    // End-of-rerank data lands via onFinish which carries the full event.
  };

  // ------------------------------------------------------------------
  // operation finish / error
  // ------------------------------------------------------------------

  onFinish = (event: any): void => {
    const callId: string | undefined = event?.callId;
    if (!callId) return;
    const op = this.operationByCallId.get(callId);
    if (!op) return;

    // Metadata (finish reason, aggregated token usage) is recorded regardless
    // of recordOutputs — it's not user-content and is what analytics / cost
    // dashboards read off the top-level span.
    if (typeof event.finishReason === "string") {
      op.span.setAttribute("gen_ai.response.finish_reason", event.finishReason);
      op.span.setAttribute("ai.response.finishReason", event.finishReason);
    }
    const totalUsage = event.totalUsage ?? event.usage;
    const usageAttrs: Record<string, any> = {};
    applyUsage(usageAttrs, totalUsage);
    for (const [k, v] of Object.entries(usageAttrs)) {
      if (v !== undefined) op.span.setAttribute(k, v);
    }

    // Write final output content onto the operation span.
    if (this.recordOutputs) {
      // Text generation: final text.
      if (typeof event.text === "string" && event.text.length > 0) {
        op.span.setAttribute("ai.response.text", event.text);
        op.span.setAttribute(SPAN_OUTPUT, event.text);
      }
      const normalizedToolCalls = normalizeToolCalls(event.toolCalls);
      if (normalizedToolCalls.length > 0) {
        op.span.setAttribute(
          "ai.response.toolCalls",
          serializeJSON(normalizedToolCalls),
        );
      }

      // Embed: final embedding(s).
      if (event.embedding !== undefined) {
        // Avoid writing the raw vectors — just record shape.
        const emb = event.embedding;
        if (Array.isArray(emb) && Array.isArray(emb[0])) {
          op.span.setAttribute("ai.embed.count", emb.length);
        } else if (Array.isArray(emb)) {
          op.span.setAttribute("ai.embed.count", 1);
        }
      }
      // Rerank: ranking array is small enough to serialize.
      if (Array.isArray(event.ranking)) {
        op.span.setAttribute("ai.rerank.ranking", serializeJSON(event.ranking));
        op.span.setAttribute(SPAN_OUTPUT, serializeJSON(event.ranking));
      }
    }

    // v7 FinishReason includes `"error"` — if the SDK surfaces the failure
    // via onFinish (rather than onError), honor it instead of stamping OK.
    if (event.finishReason === "error") {
      op.span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      op.span.setStatus({ code: SpanStatusCode.OK });
    }

    this.endOrphanChildSpansForCallId(callId);
    op.span.end();
    this.operationByCallId.delete(callId);
    this.activeStreamStepByCallId.delete(callId);
  };

  onError = (event: any): void => {
    // v7 passes either a structured `{ callId?, error }` payload or a raw
    // error value. Try to scope the error to a single operation — blindly
    // flagging every in-flight op would mark unrelated concurrent
    // generateText / streamText calls as errored.
    const rawError =
      event && typeof event === "object" && "error" in event
        ? event.error
        : event;
    const err =
      rawError instanceof Error
        ? rawError
        : new Error(
            typeof rawError === "string" ? rawError : serializeJSON(rawError),
          );
    const eventCallId: string | undefined =
      event && typeof event === "object" && typeof event.callId === "string"
        ? event.callId
        : undefined;

    // Resolve the target operation:
    //  - explicit callId  → that one (if still open)
    //  - single in-flight → that one
    //  - otherwise        → skip; do NOT flag unrelated concurrent ops.
    let targetCallId: string | undefined;
    let targetOp: OperationState | undefined;
    if (eventCallId) {
      const op = this.operationByCallId.get(eventCallId);
      if (op) {
        targetCallId = eventCallId;
        targetOp = op;
      }
    } else if (this.operationByCallId.size === 1) {
      const [k, op] = this.operationByCallId.entries().next().value!;
      targetCallId = k;
      targetOp = op;
    }
    if (!targetOp || !targetCallId) return;

    targetOp.span.recordException(err);
    targetOp.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err.message,
    });

    // End child spans + the operation span tied to this callId so we don't
    // leak if `onError` is terminal (no subsequent `onFinish`). If `onFinish`
    // does fire afterwards, its `operationByCallId.get(callId)` returns
    // undefined and it early-returns.
    this.endOrphanChildSpansForCallId(targetCallId);
    targetOp.span.end();
    this.operationByCallId.delete(targetCallId);
    this.activeStreamStepByCallId.delete(targetCallId);
  };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  /** Latest (highest-stepNumber) open step for a given callId. */
  private findLatestStep(callId: string): StepState | undefined {
    let best: StepState | undefined;
    const prefix = `${callId}:`;
    for (const [key, step] of this.stepByKey) {
      if (!key.startsWith(prefix)) continue;
      if (!best || step.stepNumber > best.stepNumber) best = step;
    }
    return best;
  }

  /**
   * End any still-open child spans owned by `callId` so the parent operation
   * span always has the latest endTime in its subtree — a degenerate provider
   * that skipped lang-model-call-end / step-finish / tool-end would otherwise
   * leave children ending after the operation and break trace hierarchy
   * semantics. Callers MUST invoke this BEFORE ending the operation span.
   *
   * Sweep order is llm + tool (leaves under step) → step. Tool spans are
   * children of step spans (see `onToolExecutionStart` where
   * `parentCtx = step?.ctx ?? op.ctx`), so step must end AFTER tool.
   */
  private endOrphanChildSpansForCallId(callId: string): void {
    const prefix = `${callId}:`;
    for (const [key, llm] of this.llmByKey) {
      if (key.startsWith(prefix)) {
        llm.span.end();
        this.llmByKey.delete(key);
      }
    }
    for (const [toolCallId, tool] of this.toolByCallId) {
      if (tool.callId === callId) {
        tool.span.end();
        this.toolByCallId.delete(toolCallId);
      }
    }
    for (const [key, step] of this.stepByKey) {
      if (key.startsWith(prefix)) {
        step.span.end();
        this.stepByKey.delete(key);
      }
    }
  }
}

/**
 * Returns a Laminar `Telemetry` integration instance. Pass it to
 * `experimental_telemetry.integrations` on any AI SDK v7 generate/stream/
 * embed/rerank call, or via `registerLaminarTelemetry()` for global opt-in.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { laminarTelemetry } from "@lmnr-ai/lmnr";
 *
 * await generateText({
 *   model: openai("gpt-4o"),
 *   prompt: "hi",
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     integrations: laminarTelemetry(),
 *   },
 * });
 * ```
 */
export const laminarTelemetry = (
  options?: LaminarTelemetryOptions,
): LaminarTelemetry => new LaminarTelemetry(options);

/**
 * Registers a Laminar `Telemetry` integration as a global receiver for every
 * AI SDK v7 call that has telemetry enabled.
 *
 * Mirrors `registerTelemetry(...)` from `ai` (which writes
 * `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`), but avoids a runtime import
 * of `ai` — callers often want to register telemetry before the first
 * provider call and must not pay the cost of eagerly loading the AI SDK.
 */
export const registerLaminarTelemetry = (
  options?: LaminarTelemetryOptions,
): LaminarTelemetry => {
  const integration = new LaminarTelemetry(options);
  const g = globalThis as unknown as {
    AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[];
  };
  if (!Array.isArray(g.AI_SDK_TELEMETRY_INTEGRATIONS)) {
    g.AI_SDK_TELEMETRY_INTEGRATIONS = [];
  }
  g.AI_SDK_TELEMETRY_INTEGRATIONS.push(integration);
  return integration;
};

/**
 * Subscribes a pino-style logger to AI SDK v7's `diagnostics_channel`, which
 * fires every lifecycle event as `{ type, event }`. Use this for debugging
 * why a span didn't appear or what attributes are on the wire.
 *
 * Returns an unsubscribe function.
 */
export const enableLaminarTelemetryDebug = (
  log: (entry: { type: string; event: unknown }) => void = (e) =>
    console.log("[aisdk:telemetry]", e.type, e.event),
): (() => void) => {
  const channel = diagnosticsChannel.channel(
    AI_SDK_TELEMETRY_DIAGNOSTIC_CHANNEL,
  );
  const handler = (message: unknown) =>
    log(message as { type: string; event: unknown });
  channel.subscribe(handler);
  return () => channel.unsubscribe(handler);
};
