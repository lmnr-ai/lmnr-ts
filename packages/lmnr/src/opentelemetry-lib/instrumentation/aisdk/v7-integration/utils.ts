import type { HrTime, Span } from "@opentelemetry/api";

import { LaminarAttributes } from "../../../tracing/attributes";
import { serializeJSON } from "../../shared/serialization";

export { serializeJSON };

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

// Convert a StandardizedPrompt-shaped object (`system` + `messages`) to an
// array of `ModelMessage`-like entries. Laminar's backend parses
// `ai.prompt.messages` as an array of AI SDK messages.
export const standardizedPromptToMessages = (event: {
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
export const normalizeToolCalls = (toolCalls: any[] | undefined): any[] => {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => ({
    toolCallType: "function",
    toolCallId: tc?.toolCallId,
    toolName: tc?.toolName,
    args:
      typeof tc?.input === "string" ? tc.input : serializeJSON(tc?.input ?? {}),
  }));
};

export const extractTextFromContent = (content: any[] | undefined): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
};

export const extractReasoningFromContent = (
  content: any[] | undefined,
): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
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
