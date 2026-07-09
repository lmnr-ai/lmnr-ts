import { LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { HrTime, Span } from "@opentelemetry/api";

import { LaminarAttributes } from "../../../tracing/attributes";
import { stringifyPromptForTelemetry } from "../utils";

export const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

export const normalizeProvider = (
  provider: string | undefined,
): string | undefined => {
  if (!provider) return undefined;
  const head = provider.split(".").shift();
  return (
    head?.toLowerCase().trim() || provider.toLowerCase().trim() || undefined
  );
};

export const applyUsage = (
  attributes: Record<string, any>,
  usage: any,
): void => {
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

// Convert a StandardizedPrompt-shaped event (`system`/`instructions` +
// `messages`) into a verbatim message array: the system prompt becomes a
// leading system message and `messages` are appended UNCHANGED — no key
// renames, no part filtering, no string→text-block rewriting. Used as the
// input fallback when the LanguageModel-level prompt is unavailable.
export const verbatimStandardizedMessages = (event: {
  system?: any;
  instructions?: any;
  messages?: any[];
}): any[] => {
  const messages: any[] = [];
  const sys = event.instructions || event.system;
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

// Build the verbatim `gen_ai.output.messages` payload from an assistant
// turn's `LanguageModelContent` array (`event.content` on
// onLanguageModelCallEnd). The content parts are recorded EXACTLY as the
// provider returned them — no key renames, no part filtering — wrapped in a
// single assistant message. The backend stores this verbatim on the span
// output and the debugger replays from it. Returns the JSON string, or
// `undefined` when there is nothing to emit.
export const buildVerbatimOutputMessages = (
  content: any[] | undefined,
): string | undefined => {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  try {
    return JSON.stringify([{ role: "assistant", content }]);
  } catch {
    return undefined;
  }
};

// Fallback output shape for paths where the verbatim provider content is not
// available (buffered stream deltas on aborted/errored streams, objectText on
// generateObject/streamObject): a single verbatim-style text part.
export const buildTextOutputMessages = (text: string): string | undefined =>
  text.length > 0
    ? buildVerbatimOutputMessages([{ type: "text", text }])
    : undefined;

// Apply `applyUsage` output directly onto a span, skipping undefined values.
export const applyUsageToSpan = (span: Span, usage: any): void => {
  const attrs: Record<string, any> = {};
  applyUsage(attrs, usage);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) span.setAttribute(k, v);
  }
};

// Set the dual finish-reason attributes used by both ai.* and gen_ai.* parsers.
export const applyFinishReason = (span: Span, finishReason: string): void => {
  span.setAttribute("gen_ai.response.finish_reason", finishReason);
  span.setAttribute("ai.response.finishReason", finishReason);
};

// Set provider + request-model attributes on an LLM span.
export const applyRequestModelAttributes = (span: Span, event: any): void => {
  if (typeof event.provider === "string") {
    const provider = normalizeProvider(event.provider);
    if (provider) span.setAttribute(LaminarAttributes.PROVIDER, provider);
    span.setAttribute("ai.model.provider", event.provider);
  }
  if (typeof event.modelId === "string") {
    span.setAttribute(LaminarAttributes.REQUEST_MODEL, event.modelId);
    span.setAttribute("ai.model.id", event.modelId);
  }
};

export const compareHrTime = (a: HrTime, b: HrTime): number => {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
};

// LaminarSpan wraps an SDK Span and copies `endTime` in its constructor (before
// `end()` was called), so reading it from the wrapper yields the stale
// `[0, 0]` snapshot. The underlying `_span` (an SDK span) mutates its own
// `endTime` on `end()`, which is what we need. Probe both fields defensively
// so exotic Span implementations still degrade gracefully.
export const readSpanEndTime = (span: Span): HrTime | undefined => {
  const inner = (span as unknown as { _span?: { endTime?: HrTime } })._span;
  const innerEnd = inner?.endTime;
  if (innerEnd && (innerEnd[0] !== 0 || innerEnd[1] !== 0)) return innerEnd;
  const outerEnd = (span as unknown as { endTime?: HrTime }).endTime;
  if (outerEnd && (outerEnd[0] !== 0 || outerEnd[1] !== 0)) return outerEnd;
  return undefined;
};

// The recorded `gen_ai.input.messages` attribute (v7 integration) and the
// debugger-replay input hash (base-language-model.ts) MUST be computed from
// the same serialized bytes, or record-time and replay-time cache keys drift.
// Both go through these two helpers — do NOT serialize the prompt any other
// way on either path.
export const verbatimPromptString = (prompt: unknown): string | null => {
  try {
    const serialized = stringifyPromptForTelemetry(
      prompt as LanguageModelV4Prompt,
    );
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
};

export const verbatimPromptMessages = (prompt: unknown): unknown[] | null => {
  const serialized = verbatimPromptString(prompt);
  if (serialized === null) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
