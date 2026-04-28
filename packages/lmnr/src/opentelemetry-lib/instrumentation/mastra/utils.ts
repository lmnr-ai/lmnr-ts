import { HrTime } from "@opentelemetry/api";

import { LaminarAttributes } from "../../tracing/attributes";
import {
  AISdkContentPart,
  AISdkMessage,
  LaminarSpanType,
  MastraExportedSpan,
  MastraUsageStats,
} from "./types";

export const stripTrailingSlash = (url: string): string =>
  url.replace(/\/+$/, "");

export const normalizeTraceId = (traceId: string): string => {
  let id = traceId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  return id.padStart(32, "0").slice(-32);
};

export const normalizeSpanId = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith("0x")) id = id.slice(2);
  return id.padStart(16, "0").slice(-16);
};

export const dateToHrTime = (date: Date): HrTime => {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1e3);
  const nanoseconds = (ms % 1e3) * 1e6;
  return [seconds, nanoseconds];
};

export const computeDuration = (start: Date, end?: Date): HrTime => {
  if (!end) return [0, 0];
  // Clamp to 0 on negative diffs: duration is semantically non-negative, and
  // OTel's HrTime contract requires a non-negative nanosecond component that
  // Math.floor + `%` don't preserve when diffMs < 0 (clock skew, reordered
  // Mastra timestamps).
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  return [Math.floor(diffMs / 1e3), (diffMs % 1e3) * 1e6];
};

export const normalizeProvider = (provider: string): string =>
  provider.split(".").shift()?.toLowerCase().trim() ||
  provider.toLowerCase().trim();

// `model_step` is Laminar's atomic LLM call. `model_generation` wraps the
// whole agent-to-LLM flow (which may include multiple steps + tool calls),
// so it stays DEFAULT.
export const mapLaminarSpanType = (spanType: string): LaminarSpanType => {
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

export const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

type AttrPrimitive = string | number | boolean;
export const toAttributeValue = (
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

export const extractMessages = (input: unknown): unknown[] | undefined => {
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

// `MODEL_GENERATION.input` is the messages array the user passed into
// `agent.generate(...)`, forwarded by Mastra to the AI SDK unchanged. It's
// already in AI SDK shape by construction — the AI SDK would have rejected
// it before observability fired otherwise. Just coerce non-object items to
// a string user message so `ai.prompt.messages` always serializes as a
// well-formed message list.
export const normalizeInputMessages = (raw: unknown[]): AISdkMessage[] => {
  const out: AISdkMessage[] = [];
  for (const m of raw) {
    if (m == null) continue;
    if (typeof m === "object") {
      out.push(m as AISdkMessage);
      continue;
    }
    out.push({
      role: "user",
      content: typeof m === "string" ? m : serializeJSON(m),
    });
  }
  return out;
};

export const buildAssistantMessageFromStepOutput = (
  output: unknown,
  reasoningText?: string,
): AISdkMessage | null => {
  if (!output || typeof output !== "object") return null;
  const outObj = output as Record<string, unknown>;
  const parts: AISdkContentPart[] = [];
  // Reasoning first, mirroring the order the model produced: thinking →
  // answer → tool-calls. AI SDK content-part shape for reasoning is
  // `{type: "reasoning", text}`.
  if (typeof reasoningText === "string" && reasoningText.length > 0) {
    parts.push({ type: "reasoning", text: reasoningText });
  }
  if (typeof outObj.text === "string" && outObj.text.length > 0) {
    parts.push({ type: "text", text: outObj.text });
  }
  if (Array.isArray(outObj.toolCalls)) {
    for (const tc of outObj.toolCalls as Array<Record<string, unknown>>) {
      if (!tc) continue;
      parts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId as string | undefined,
        toolName: tc.toolName as string | undefined,
        // `args` is the legacy AI SDK v4 name, `input` is v5+; keep both
        // until we drop v4 support.
        input: tc.input ?? tc.args,
      });
    }
  }
  if (parts.length === 0) return null;
  return { role: "assistant", content: parts };
};

export const extractToolCallId = (
  span: MastraExportedSpan,
): string | undefined => {
  const v = span.attributes?.toolCallId;
  return typeof v === "string" ? v : undefined;
};

// Mastra names tool spans like `tool: 'myToolId'` or, for MCP tools,
// `mcp_tool: 'toolId' on 'serverName'` (see @mastra/core buildSpanName).
// Strip that prefix + quotes (and the trailing ` on '<server>'` for MCP) so
// both the TOOL span's `ai.toolCall.name` and the tool-result message's
// `toolName` agree on the raw tool id.
export const cleanMastraToolName = (
  name: string | undefined,
): string | undefined =>
  name?.replace(/^(?:mcp_tool|tool):\s*'?(.*?)'?(?:\s+on\s+'[^']*')?$/, "$1");

// Tool-call args are sometimes a string (already-serialized JSON), sometimes
// an object — stringify the latter so `ai.response.toolCalls` is always a
// JSON-string at the AI SDK boundary. Mirror `serializeJSON`'s guard so
// unserializable inputs (BigInt, circular refs) degrade the arg payload
// rather than bubbling up and causing the caller's outer catch to drop the
// whole LLM span.
export const stringifyArgs = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return "[unserializable]";
  }
};

export const formatUsage = (
  usage?: MastraUsageStats,
): Record<string, number> => {
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
  if (typeof usage.outputDetails?.reasoning === "number") {
    out["gen_ai.usage.reasoning_tokens"] = usage.outputDetails.reasoning;
  }
  return out;
};
