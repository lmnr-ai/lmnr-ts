import type { HrTime, Span } from "@opentelemetry/api";

import { LaminarAttributes, SPAN_INPUT } from "../../../tracing/attributes";

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

// Content-part `type` tags the app-server's `InstrumentationChatMessageContentPart`
// enum (`app-server/src/language_model/chat_message.rs`) can deserialize. A part
// with any other tag — v7 history parts like `reasoning`, `reasoning-file`,
// `custom`, `tool-approval-request`/`-response` — fails the server's all-or-nothing
// `Vec<...>` parse, which then stringifies the ENTIRE content array into one Text
// blob (the double-stringified assistant history of LAM-1912; thinking models are
// the trigger because only they put `reasoning` parts into `messagesForNextStep`).
// Strip such parts at recording time so the stored input always parses as
// structured parts. The debugger replay reshape (`src/debug/aisdk-normalize.ts`)
// applies the SAME strip before hashing — keep the two in sync.
const SERVER_PARSABLE_PART_TYPES = new Set([
  "text",
  "image",
  "image_url",
  "document",
  "file",
  "tool-call",
  "tool-result",
]);

export const isServerParsablePart = (part: unknown): boolean =>
  part !== null &&
  typeof part === "object" &&
  SERVER_PARSABLE_PART_TYPES.has((part as { type?: unknown }).type as string);

const stripUnsupportedParts = (
  m: LooseMessageNoStringContent,
): LooseMessageNoStringContent =>
  Array.isArray(m.content)
    ? { ...m, content: m.content.filter(isServerParsablePart) }
    : m;

// Convert a StandardizedPrompt-shaped object (`system` + `messages`) to an
// array of `ModelMessage`-like entries. Laminar's backend parses
// `ai.prompt.messages` as an array of AI SDK messages.
export const standardizedPromptToMessages = (event: {
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
    for (const m of event.messages)
      messages.push(
        stripUnsupportedParts(
          convertRawStringTextToTextBlock(m as LooseMessage),
        ),
      );
  }
  return messages;
};

type LooseMessage = {
  role: string;
  content: string | Record<string, any>[];
  [k: string]: unknown;
};
type LooseMessageNoStringContent = {
  role: string;
  content: Record<string, any>[];
  [k: string]: unknown;
};
const convertRawStringTextToTextBlock = (
  m: LooseMessage,
): LooseMessageNoStringContent => ({
  ...m,
  content:
    typeof m?.content === "string"
      ? [{ type: "text", text: m.content }]
      : m?.content,
});

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

// Build the OTel GenAI `gen_ai.output.messages` payload from a single
// assistant turn's reasoning / text / tool calls. The backend stores this
// verbatim on the span output and the debugger replays from it, so this is the
// single output shape for v7 — no legacy `ai.response.*` / `SPAN_OUTPUT` writes.
// `toolCalls` are the `normalizeToolCalls` output (`{toolCallId, toolName, args}`).
// Returns the JSON string, or `undefined` when there is nothing to emit.
export const buildGenAiOutputMessages = (args: {
  text?: string;
  reasoningText?: string;
  toolCalls?: any[];
}): string | undefined => {
  const parts: any[] = [];
  if (args.reasoningText && args.reasoningText.length > 0) {
    parts.push({ type: "thinking", content: args.reasoningText });
  }
  if (args.text && args.text.length > 0) {
    parts.push({ type: "text", content: args.text });
  }
  for (const tc of args.toolCalls ?? []) {
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
  if (parts.length === 0) return undefined;
  return JSON.stringify([{ role: "assistant", parts }]);
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

// Serialize prompt messages from a StandardizedPrompt-shaped event and set
// `ai.prompt.messages` + `SPAN_INPUT` on the span. No-ops when the event
// carries no messages.
export const applyPromptMessages = (span: Span, event: any): void => {
  const msgs = standardizedPromptToMessages(event);
  if (msgs.length === 0) return;
  const serialized = serializeJSON(msgs);
  span.setAttribute("ai.prompt.messages", serialized);
  span.setAttribute(SPAN_INPUT, serialized);
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
