/**
 * Pure functions that turn a finished Langfuse span's attributes into the
 * Laminar / OTel GenAI attributes added to Laminar's copy of the span. Port of
 * the langfuse path of lmnr-python's
 * `opentelemetry_lib/opentelemetry/instrumentation/langfuse/translate.py` +
 * `processor.py::_translate` (the openinference / LiteLLM path is not ported:
 * those spans never go through the `langfuse-sdk` tracer in JS).
 */
import { type Attributes, type AttributeValue } from "@opentelemetry/api";

import { parseJson, toJson } from "../../../utils";
import {
  ASSOCIATION_PROPERTIES,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
  LaminarAttributes,
  SESSION_ID,
  SPAN_BRIDGE_NAME,
  SPAN_BRIDGE_VERSION,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
  USER_ID,
} from "../../tracing/attributes";

// Langfuse attribute names (`LangfuseOtelSpanAttributes` in @langfuse/core),
// duplicated so the SDK has no runtime dependency on Langfuse.
export const LANGFUSE_TRACER_NAME = "langfuse-sdk";
const TRACE_INPUT = "langfuse.trace.input";
const TRACE_OUTPUT = "langfuse.trace.output";
const TRACE_TAGS = "langfuse.trace.tags";
const TRACE_METADATA = "langfuse.trace.metadata";
const TRACE_USER_ID = "user.id";
const TRACE_SESSION_ID = "session.id";
const OBSERVATION_TYPE = "langfuse.observation.type";
const OBSERVATION_INPUT = "langfuse.observation.input";
const OBSERVATION_OUTPUT = "langfuse.observation.output";
const OBSERVATION_MODEL = "langfuse.observation.model.name";
const OBSERVATION_MODEL_PARAMETERS = "langfuse.observation.model.parameters";
const OBSERVATION_METADATA = "langfuse.observation.metadata";
const METADATA_INSTRUCTIONS = `${OBSERVATION_METADATA}.instructions`;
const METADATA_TOOLS = `${OBSERVATION_METADATA}.tools`;
const OBSERVATION_USAGE_DETAILS = "langfuse.observation.usage_details";
const OBSERVATION_COST_DETAILS = "langfuse.observation.cost_details";
const OBSERVATION_LEVEL = "langfuse.observation.level";
const OBSERVATION_STATUS_MESSAGE = "langfuse.observation.status_message";

// GenAI semconv usage keys; app-server normalizes these. Cache and reasoning
// counts are subsets of the input / output token counts.
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS =
  "gen_ai.usage.cache_write.input_tokens";
export const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS =
  "gen_ai.usage.reasoning.output_tokens";

const LLM_OBSERVATION_TYPES = new Set([
  "generation",
  "completion",
  "embedding",
]);
const TOOL_OBSERVATION_TYPES = new Set(["tool"]);

// `modelParameters` keys → the request attributes Laminar's own
// instrumentations write. The first key present wins (the max-token aliases);
// the rest stay in the raw `langfuse.observation.model.parameters`.
const NUMBER_MODEL_PARAMETERS: [string, string][] = [
  ["temperature", "gen_ai.request.temperature"],
  ["top_p", "gen_ai.request.top_p"],
  ["top_k", "gen_ai.request.top_k"],
  ["max_tokens", "gen_ai.request.max_tokens"],
  ["max_completion_tokens", "gen_ai.request.max_tokens"],
  ["max_output_tokens", "gen_ai.request.max_tokens"],
  ["frequency_penalty", "gen_ai.request.frequency_penalty"],
  ["presence_penalty", "gen_ai.request.presence_penalty"],
  ["seed", "gen_ai.request.seed"],
  ["n", "gen_ai.request.choice.count"],
];
const STRING_MODEL_PARAMETERS: [string, string][] = [
  ["reasoning_effort", "gen_ai.request.reasoning.level"],
  ["reasoning_summary", "gen_ai.request.reasoning_summary"],
  ["service_tier", "gen_ai.request.service_tier"],
];

// LangChain's `ls_provider` values that differ from the provider names in
// Laminar's model prices.
const LS_PROVIDER_ALIASES: Record<string, string> = {
  amazon_bedrock: "bedrock",
  google_vertexai: "vertex_ai",
  google_genai: "gemini",
};

// OTel `SpanStatusCode.ERROR`.
const STATUS_CODE_ERROR = 2;

type Json = Record<string, any>;

/**
 * Attributes for Laminar's copy of a span. `undefined` removes one: a
 * `langfuse.*` value already carried by the Laminar attributes it was
 * converted to, which Laminar would otherwise store (and bill) twice.
 */
export type Translated = Record<string, AttributeValue | undefined>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const firstNumber = (obj: Json, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = asNumber(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** Sum of the numeric values whose key matches; undefined if none does. */
const sumMatching = (
  obj: Json,
  matches: (key: string) => boolean,
): number | undefined => {
  let total: number | undefined;
  for (const [key, value] of Object.entries(obj)) {
    const n = asNumber(value);
    if (n !== undefined && matches(key.toLowerCase())) {
      total = (total ?? 0) + n;
    }
  }
  return total;
};

const nestedNumber = (
  obj: Json,
  parents: string[],
  key: string,
): number | undefined => {
  for (const parent of parents) {
    const nested = obj[parent];
    if (isObject(nested)) {
      const value = asNumber(nested[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
};

/**
 * Token counts from `langfuse.observation.usage_details`.
 *
 * Langfuse's integrations report `input` / `output` WITHOUT their details:
 * `@langfuse/openai` subtracts every `prompt_tokens_details` entry from
 * `prompt_tokens` and reports it as `input_<key>` (`input_cached_tokens`),
 * `@langfuse/langchain` does the same (`input_cache_read`,
 * `output_reasoning`). Laminar's backend wants the totals (it subtracts cache
 * tokens itself), so every `input_*` / `output_*` key is added back. The
 * OpenAI-style shapes (`prompt_tokens`, `input_tokens`, ...) are already
 * totals and are taken as they are.
 */
export const usageAttributes = (
  usageRaw: unknown,
): Record<string, AttributeValue> => {
  const usage = parseJson(usageRaw);
  if (!isObject(usage)) return {};
  const out: Record<string, AttributeValue> = {};

  const isDetailOf = (prefix: "input" | "output") => (key: string) =>
    key.startsWith(`${prefix}_`) && key !== `${prefix}_tokens`;

  let input = asNumber(usage.input);
  if (input !== undefined) {
    input += sumMatching(usage, isDetailOf("input")) ?? 0;
  } else {
    input = firstNumber(usage, "prompt_tokens", "input_tokens", "promptTokens");
  }
  let output = asNumber(usage.output);
  if (output !== undefined) {
    output += sumMatching(usage, isDetailOf("output")) ?? 0;
  } else {
    output = firstNumber(
      usage,
      "completion_tokens",
      "output_tokens",
      "completionTokens",
    );
  }
  const total =
    firstNumber(usage, "total", "total_tokens", "totalTokens") ??
    (input !== undefined || output !== undefined
      ? (input ?? 0) + (output ?? 0)
      : undefined);

  const cacheRead =
    sumMatching(
      usage,
      (k) => k.includes("cache_read") || k.includes("cached"),
    ) ??
    nestedNumber(
      usage,
      ["prompt_tokens_details", "input_tokens_details"],
      "cached_tokens",
    );
  const cacheWrite = sumMatching(
    usage,
    (k) => k.includes("cache_creation") || k.includes("cache_write"),
  );
  const reasoning =
    sumMatching(usage, (k) => k.includes("reasoning")) ??
    nestedNumber(
      usage,
      ["completion_tokens_details", "output_tokens_details"],
      "reasoning_tokens",
    );

  if (input !== undefined) out[LaminarAttributes.INPUT_TOKEN_COUNT] = input;
  if (output !== undefined) out[LaminarAttributes.OUTPUT_TOKEN_COUNT] = output;
  if (total !== undefined) out[LaminarAttributes.TOTAL_TOKEN_COUNT] = total;
  if (cacheRead !== undefined) {
    out[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = cacheRead;
  }
  if (cacheWrite !== undefined) {
    out[GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS] = cacheWrite;
  }
  if (reasoning !== undefined) {
    out[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] = reasoning;
  }
  return out;
};

/** Costs from `langfuse.observation.cost_details`, only when present. */
export const costAttributes = (
  costRaw: unknown,
): Record<string, AttributeValue> => {
  const cost = parseJson(costRaw);
  if (!isObject(cost)) return {};
  const out: Record<string, AttributeValue> = {};
  const input = asNumber(cost.input);
  const output = asNumber(cost.output);
  const total =
    asNumber(cost.total) ??
    (input !== undefined || output !== undefined
      ? (input ?? 0) + (output ?? 0)
      : undefined);
  if (input !== undefined) out[LaminarAttributes.INPUT_COST] = input;
  if (output !== undefined) out[LaminarAttributes.OUTPUT_COST] = output;
  if (total !== undefined) out[LaminarAttributes.TOTAL_COST] = total;
  return out;
};

/** A string metadata value; @langfuse/* 6.x JSON-encodes it, 4.x / 5.x don't. */
const metadataString = (value: unknown): string | undefined => {
  const parsed = parseJson(value);
  const s = typeof parsed === "string" ? parsed : value;
  return typeof s === "string" && s ? s : undefined;
};

/**
 * Request parameters from `langfuse.observation.model.parameters`.
 * `@langfuse/openai` records the Responses API's `reasoning` from the response
 * into the observation metadata instead, i.e. the effort that was applied
 * (a default when the request set none), so it goes to the response key.
 */
export const modelParameterAttributes = (attrs: Attributes): Translated => {
  const out: Translated = {};
  const params = parseJson(attrs[OBSERVATION_MODEL_PARAMETERS]);
  if (isObject(params)) {
    const rest: Json = { ...params };
    for (const [key, attr] of NUMBER_MODEL_PARAMETERS) {
      const value = asNumber(rest[key]);
      if (value !== undefined && !(attr in out)) {
        out[attr] = value;
        delete rest[key];
      }
    }
    for (const [key, attr] of STRING_MODEL_PARAMETERS) {
      const value = rest[key];
      if (typeof value === "string" && value) {
        out[attr] = value;
        delete rest[key];
      }
    }
    const stop = typeof rest.stop === "string" ? [rest.stop] : rest.stop;
    if (
      Array.isArray(stop) &&
      stop.length > 0 &&
      stop.every((s) => typeof s === "string")
    ) {
      out["gen_ai.request.stop_sequences"] = stop;
      delete rest.stop;
    }
    // Only the parameters that have no request attribute stay.
    if (Object.keys(out).length > 0) {
      out[OBSERVATION_MODEL_PARAMETERS] =
        Object.keys(rest).length > 0 ? toJson(rest) : undefined;
    }
  }
  const reasoning = parseJson(attrs[`${OBSERVATION_METADATA}.reasoning`]);
  if (isObject(reasoning) && typeof reasoning.effort === "string") {
    out["gen_ai.response.reasoning.level"] = reasoning.effort;
  }
  return out;
};

/**
 * The provider, which Langfuse records only through LangChain's
 * `ls_provider` observation metadata. `@langfuse/openai` records none: the
 * client's base URL may point at any OpenAI-compatible API.
 */
export const providerAttributes = (
  attrs: Attributes,
): Record<string, AttributeValue> => {
  const provider = metadataString(attrs[`${OBSERVATION_METADATA}.ls_provider`]);
  if (!provider) return {};
  return {
    [LaminarAttributes.PROVIDER]: LS_PROVIDER_ALIASES[provider] ?? provider,
  };
};

// Responses API request keys `langfuse` SDKs record next to `input`.
const RESPONSES_PROMPT_KEYS = new Set([
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
// Responses API items that hold an assistant tool call, and their results.
const RESPONSES_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const RESPONSES_CALL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

/**
 * Split a Langfuse LLM input into (messages, tool definitions).
 * - chat (`@langfuse/openai`, `@langfuse/langchain`): a bare message list, or
 *   `{messages, tools|functions, tool_choice}`;
 * - Responses API: `@langfuse/openai` records only the `input` (a string or
 *   an item list; tools and instructions go to the observation metadata),
 *   Python's `langfuse.openai` `{input, tools, tool_choice, ...}`.
 * A bare string (manual generations) is a user message.
 */
export const splitLlmInput = (
  inputRaw: unknown,
): { messages: unknown[]; tools?: unknown } | undefined => {
  const parsed = parseJson(inputRaw);
  if (typeof parsed === "string") {
    return parsed
      ? { messages: [{ role: "user", content: parsed }] }
      : undefined;
  }
  if (Array.isArray(parsed)) return { messages: parsed };
  if (!isObject(parsed)) return undefined;
  const tools = parsed.tools ?? parsed.functions;
  if (Array.isArray(parsed.messages)) {
    return { messages: parsed.messages, tools };
  }
  if (
    "input" in parsed &&
    Object.keys(parsed).every((k) => RESPONSES_PROMPT_KEYS.has(k))
  ) {
    const input = parsed.input;
    let messages: unknown[];
    if (typeof input === "string") {
      messages = [{ role: "user", content: input }];
    } else if (Array.isArray(input)) {
      messages = [...input];
    } else {
      return undefined;
    }
    if (typeof parsed.instructions === "string" && parsed.instructions) {
      messages.unshift({ role: "system", content: parsed.instructions });
    }
    return { messages, tools };
  }
  return undefined;
};

/**
 * Older `@langfuse/langchain` inlines tool definitions into the message list
 * as `role: "tool"` messages whose content is the definition (OpenAI
 * `{type: "function", function}` or Anthropic `{name, input_schema}`). Pull
 * them out into the tool definitions.
 */
export const splitLangchainToolDefinitions = (
  messages: unknown[],
): { messages: unknown[]; tools: unknown[] } => {
  const kept: unknown[] = [];
  const tools: unknown[] = [];
  for (const msg of messages) {
    if (isObject(msg) && msg.role === "tool" && isObject(msg.content)) {
      const content = msg.content;
      if (content.type === "function" && isObject(content.function)) {
        tools.push(content.function);
        continue;
      }
      if ("input_schema" in content && "name" in content) {
        tools.push(content);
        continue;
      }
    }
    kept.push(msg);
  }
  return { messages: kept, tools };
};

/**
 * A Langfuse LLM output as a list, before `normalizeMessages`: one message
 * (chat), a string (`@langfuse/openai`'s streamed chat text and Responses
 * `output_text`), or Responses API output items (a list, or the only item).
 */
export const llmOutputMessages = (
  outputRaw: unknown,
): unknown[] | undefined => {
  const parsed = parseJson(outputRaw);
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed)) return [parsed];
  if (typeof parsed === "string" && parsed) {
    return [{ role: "assistant", content: parsed }];
  }
  return undefined;
};

const toolCallPart = (id: unknown, name: unknown, args: unknown): Json => ({
  type: "tool_call",
  id: id ?? null,
  name: name ?? null,
  arguments: args ?? null,
});

/** Summary (else raw reasoning) text of a Responses API reasoning item. */
const reasoningText = (item: Json): string => {
  for (const key of ["summary", "content"]) {
    const blocks = item[key];
    if (!Array.isArray(blocks)) continue;
    const texts = blocks
      .filter((b) => isObject(b) && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join("\n\n");
  }
  return "";
};

/**
 * One content part in Laminar's shape (`text`, `reasoning`, `tool_call`); an
 * empty list drops it. Unknown parts are kept as they are.
 */
const normalizePart = (part: unknown): unknown[] => {
  if (typeof part === "string") return [{ type: "text", text: part }];
  if (!isObject(part)) return [part];
  const kind = part.type;
  if (TEXT_PART_TYPES.has(kind) && typeof part.text === "string") {
    return [{ type: "text", text: part.text }];
  }
  if (kind === "tool_call") {
    // LangChain names the arguments `args`.
    const args = "arguments" in part ? part.arguments : part.args;
    return [toolCallPart(part.id, part.name, args)];
  }
  if (kind === "tool_use") {
    return [toolCallPart(part.id, part.name, part.input)];
  }
  if (RESPONSES_CALL_TYPES.has(kind)) {
    const args = "arguments" in part ? part.arguments : part.input;
    return [toolCallPart(part.call_id || part.id, part.name, args)];
  }
  if (kind === "reasoning" || kind === "thinking") {
    let text = kind === "reasoning" ? part.text : part.thinking;
    if (typeof text !== "string") text = reasoningText(part);
    return text ? [{ type: "reasoning", text }] : [];
  }
  if (kind === "redacted_thinking") return [];
  return [part];
};

/**
 * Drop repeated tool calls (same id) within one message: LangChain keeps a
 * call both in the content blocks (Anthropic `tool_use`, Responses
 * `function_call`) and in `tool_calls`.
 */
const dedupeToolCalls = (parts: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (!isObject(part) || part.type !== "tool_call") return true;
    if (typeof part.id !== "string" || !part.id) return true;
    if (seen.has(part.id)) return false;
    seen.add(part.id);
    return true;
  });
};

/**
 * Content parts as message content. A single text part becomes a string, so
 * `"hi"` and `[{type: "text", text: "hi"}]` hash the same.
 */
const collapse = (parts: unknown[]): unknown => {
  const only = parts[0];
  if (
    parts.length === 1 &&
    isObject(only) &&
    only.type === "text" &&
    Object.keys(only).length === 2 &&
    "text" in only
  ) {
    return only.text;
  }
  return parts;
};

const normalizeContent = (content: unknown): unknown =>
  Array.isArray(content)
    ? collapse(dedupeToolCalls(content.flatMap(normalizePart)))
    : content;

/**
 * A chat message as `{role, content, tool_call_id?, name?}`; provider extras
 * (`refusal`, `annotations`, LangChain's `additional_kwargs`, ...) are
 * dropped so a turn's output equals its copy in the next call's history.
 * Anthropic `tool_result` parts become `tool` messages.
 */
const normalizeMessage = (msg: Json, isOutput: boolean): Json[] => {
  let role = msg.role;
  if (role === "model" || (role == null && isOutput)) role = "assistant";
  const content = msg.content;
  let parts: unknown[] | undefined = Array.isArray(content)
    ? content.flatMap(normalizePart)
    : undefined;

  const calls: unknown[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (isObject(tc) && isObject(tc.function)) {
        calls.push(
          toolCallPart(tc.id, tc.function.name, tc.function.arguments),
        );
      } else if (isObject(tc) && tc.type === undefined && "name" in tc) {
        // LangChain `{id, name, args}`.
        calls.push(...normalizePart({ ...tc, type: "tool_call" }));
      } else {
        calls.push(...normalizePart(tc));
      }
    }
  }
  if (isObject(msg.function_call)) {
    calls.push(
      toolCallPart(null, msg.function_call.name, msg.function_call.arguments),
    );
  }
  if (calls.length > 0) {
    parts ??=
      typeof content === "string" && content
        ? [{ type: "text", text: content }]
        : [];
    parts.push(...calls);
  }

  const results: Json[] = [];
  if (parts !== undefined && role === "user") {
    const rest: unknown[] = [];
    for (const part of parts) {
      if (isObject(part) && part.type === "tool_result") {
        results.push({
          role: "tool",
          content: normalizeContent(part.content),
          tool_call_id: part.tool_use_id ?? null,
        });
      } else {
        rest.push(part);
      }
    }
    parts = rest;
    if (results.length > 0 && parts.length === 0) return results;
  }

  const out: Json = {
    role: role ?? null,
    content:
      parts !== undefined
        ? collapse(dedupeToolCalls(parts))
        : (content ?? null),
  };
  for (const key of ["tool_call_id", "name"]) {
    if (msg[key] != null) out[key] = msg[key];
  }
  return [...results, out];
};

/**
 * Bring LLM input / output messages to Laminar's shape: `{role, content}`,
 * where content is a string or a list of `text`, `reasoning` and `tool_call`
 * (`{id, name, arguments}`) parts, and a tool result is
 * `{role: "tool", content, tool_call_id}`.
 *
 * Covers OpenAI chat (`tool_calls`), Responses API items (`function_call`,
 * `function_call_output`, `reasoning`, `message`), LangChain (`args`) and
 * Anthropic (`tool_use`, `tool_result`, `thinking`). Inputs and outputs go
 * through the same rules, so an assistant turn is identical in the call that
 * produced it and in the next call's history (app-server dedups messages by
 * hash). Consecutive Responses API items of one assistant turn (reasoning,
 * calls, the assistant message) are merged into one assistant message.
 * Same rules as lmnr-python's `translate.py::normalize_messages`.
 */
export const normalizeMessages = (
  messages: unknown[],
  isOutput: boolean,
): unknown[] => {
  const out: unknown[] = [];
  const turns: Json[] = [];
  // Parts of the open Responses assistant turn.
  let turn: unknown[] | undefined;
  const openTurn = (): unknown[] => {
    if (turn === undefined) {
      turn = [];
      const message = { role: "assistant", content: turn };
      out.push(message);
      turns.push(message);
    }
    return turn;
  };

  for (const item of messages) {
    if (!isObject(item)) {
      out.push(item);
      turn = undefined;
      continue;
    }
    const kind = item.type;
    if (
      !("role" in item) &&
      (RESPONSES_CALL_TYPES.has(kind) ||
        kind === "reasoning" ||
        (typeof kind === "string" && kind.endsWith("_call")))
    ) {
      openTurn().push(...normalizePart(item));
      continue;
    }
    if (RESPONSES_CALL_OUTPUT_TYPES.has(kind)) {
      out.push({
        role: "tool",
        content: normalizeContent(item.output),
        tool_call_id: item.call_id ?? null,
      });
      turn = undefined;
      continue;
    }
    if (
      "role" in item ||
      (isOutput && ("content" in item || "tool_calls" in item))
    ) {
      const normalized = normalizeMessage(item, isOutput);
      const last = normalized[normalized.length - 1];
      if (
        normalized.length === 1 &&
        last.role === "assistant" &&
        (turn !== undefined || kind === "message")
      ) {
        const content = last.content;
        if (Array.isArray(content)) openTurn().push(...content);
        else if (content != null) openTurn().push(...normalizePart(content));
        continue;
      }
      out.push(...normalized);
      turn = undefined;
      continue;
    }
    out.push(item);
    turn = undefined;
  }

  for (const message of turns) {
    message.content = collapse(dedupeToolCalls(message.content));
  }
  return out;
};

/**
 * A metadata value. @langfuse/* 6.x JSON-encodes every value, so there a
 * JSON-encoded primitive is decoded; 4.x and 5.x write strings raw, and a raw
 * "12345" or "true" must stay a string.
 */
const decodeMetadataValue = (
  value: unknown,
  jsonEncoded: boolean,
): AttributeValue | undefined => {
  if (!jsonEncoded || typeof value !== "string") {
    return value as AttributeValue | undefined;
  }
  const parsed = parseJson(value);
  if (
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean"
  ) {
    return parsed;
  }
  return value;
};

/**
 * Trace-level Langfuse attributes → Laminar association properties. Only
 * `langfuse.trace.metadata.*` becomes Laminar metadata; observation-level
 * metadata stays as its raw `langfuse.*` attribute.
 */
export const traceAttributes = (
  attrs: Attributes,
  jsonEncodedMetadata: boolean,
): Record<string, AttributeValue> => {
  const out: Record<string, AttributeValue> = {};
  const sessionId = attrs[TRACE_SESSION_ID];
  if (typeof sessionId === "string" && sessionId) out[SESSION_ID] = sessionId;
  const userId = attrs[TRACE_USER_ID];
  if (typeof userId === "string" && userId) out[USER_ID] = userId;

  const tags = attrs[TRACE_TAGS];
  if (Array.isArray(tags) && tags.length > 0) {
    out[`${ASSOCIATION_PROPERTIES}.tags`] = Array.from(
      new Set(tags.filter((t) => t !== null && t !== undefined).map(String)),
    );
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (key === TRACE_METADATA) {
      const parsed = parseJson(value);
      if (isObject(parsed)) {
        for (const [mk, mv] of Object.entries(parsed)) {
          const v =
            typeof mv === "string" ||
            typeof mv === "number" ||
            typeof mv === "boolean"
              ? mv
              : toJson(mv);
          if (v !== undefined) {
            out[`${ASSOCIATION_PROPERTIES}.metadata.${mk}`] = v;
          }
        }
      }
    } else if (key.startsWith(`${TRACE_METADATA}.`)) {
      const v = decodeMetadataValue(value, jsonEncodedMetadata);
      if (v !== undefined) {
        out[
          `${ASSOCIATION_PROPERTIES}.metadata.${key.slice(TRACE_METADATA.length + 1)}`
        ] = v;
      }
    }
  }
  return out;
};

const ioAttributes = (attrs: Attributes, isLlm: boolean): Translated => {
  const out: Translated = {};
  const setJson = (key: string, value: unknown) => {
    const json = toJson(value);
    if (json !== undefined) out[key] = json;
  };

  // Either way the `langfuse.*` key the value came from is dropped.
  const inputKey =
    attrs[OBSERVATION_INPUT] !== undefined ? OBSERVATION_INPUT : TRACE_INPUT;
  const inputRaw = attrs[inputKey];
  let inputHandled = false;
  if (isLlm && inputRaw !== undefined) {
    const split = splitLlmInput(inputRaw);
    if (split) {
      const lc = splitLangchainToolDefinitions(split.messages);
      const messages = normalizeMessages(lc.messages, false);
      // `@langfuse/openai` records only a Responses call's `input`; its
      // instructions and tools land in the observation metadata, taken from
      // the response.
      const instructions = metadataString(attrs[METADATA_INSTRUCTIONS]);
      if (instructions) {
        messages.unshift({ role: "system", content: instructions });
        out[METADATA_INSTRUCTIONS] = undefined;
      }
      setJson(GEN_AI_INPUT_MESSAGES, messages);
      const nonEmpty = (v: unknown) =>
        Array.isArray(v) && v.length > 0 ? v : undefined;
      let tools = nonEmpty(split.tools) ?? nonEmpty(lc.tools);
      if (!tools) {
        tools = nonEmpty(parseJson(attrs[METADATA_TOOLS]));
        if (tools) out[METADATA_TOOLS] = undefined;
      }
      if (tools) setJson(GEN_AI_TOOL_DEFINITIONS, tools);
      inputHandled = true;
    }
  }
  if (!inputHandled && typeof inputRaw === "string" && inputRaw) {
    out[SPAN_INPUT] = inputRaw;
    inputHandled = true;
  }
  if (inputHandled) out[inputKey] = undefined;

  const outputKey =
    attrs[OBSERVATION_OUTPUT] !== undefined ? OBSERVATION_OUTPUT : TRACE_OUTPUT;
  const outputRaw = attrs[outputKey];
  let outputHandled = false;
  if (isLlm && outputRaw !== undefined) {
    const messages = llmOutputMessages(outputRaw);
    if (messages) {
      setJson(GEN_AI_OUTPUT_MESSAGES, normalizeMessages(messages, true));
      outputHandled = true;
    }
  }
  if (!outputHandled && typeof outputRaw === "string" && outputRaw) {
    out[SPAN_OUTPUT] = outputRaw;
    outputHandled = true;
  }
  if (outputHandled) out[outputKey] = undefined;
  return out;
};

export interface TranslatedSpan {
  /** Set on Laminar's copy; `undefined` removes the attribute from it. */
  attributes: Translated;
  /** Set when Laminar's copy must carry a synthesized `exception` event. */
  errorMessage?: string;
}

const majorVersion = (version: string | undefined): number =>
  version === undefined ? NaN : parseInt(version.split(".")[0], 10);

/**
 * Translate a finished Langfuse span. `attrs` are the span's own attributes,
 * which are never modified; the result is added on top of them on Laminar's
 * copy, so every raw `langfuse.*` attribute is kept.
 */
export const translateLangfuseSpan = (
  attrs: Attributes,
  status: { code?: number; message?: string } | undefined,
  bridgeVersion: string | undefined,
): TranslatedSpan => {
  const out: Translated = {
    [SPAN_BRIDGE_NAME]: "langfuse",
  };
  if (bridgeVersion) out[SPAN_BRIDGE_VERSION] = bridgeVersion;

  const obsType = attrs[OBSERVATION_TYPE];
  const type = typeof obsType === "string" ? obsType.toLowerCase() : undefined;
  const isLlm = type !== undefined && LLM_OBSERVATION_TYPES.has(type);
  out[SPAN_TYPE] = isLlm
    ? "LLM"
    : type !== undefined && TOOL_OBSERVATION_TYPES.has(type)
      ? "TOOL"
      : "DEFAULT";

  const model = attrs[OBSERVATION_MODEL];
  if (typeof model === "string" && model) {
    out[LaminarAttributes.REQUEST_MODEL] = model;
    out[LaminarAttributes.RESPONSE_MODEL] = model;
    out[OBSERVATION_MODEL] = undefined;
  }
  const usage = usageAttributes(attrs[OBSERVATION_USAGE_DETAILS]);
  if (Object.keys(usage).length > 0) out[OBSERVATION_USAGE_DETAILS] = undefined;
  const cost = costAttributes(attrs[OBSERVATION_COST_DETAILS]);
  if (Object.keys(cost).length > 0) out[OBSERVATION_COST_DETAILS] = undefined;

  Object.assign(
    out,
    providerAttributes(attrs),
    modelParameterAttributes(attrs),
    usage,
    cost,
    ioAttributes(attrs, isLlm),
    traceAttributes(attrs, majorVersion(bridgeVersion) >= 6),
  );

  // Langfuse never records exception events: a throw inside
  // `startActiveObservation` sets the OTel status, one inside `observe()`
  // sets `langfuse.observation.level`. Laminar only marks a span failed
  // through an `exception` event.
  let errorMessage: string | undefined;
  if (attrs[OBSERVATION_LEVEL] === "ERROR") {
    const msg = attrs[OBSERVATION_STATUS_MESSAGE];
    errorMessage =
      typeof msg === "string" && msg ? msg : (status?.message ?? "");
  } else if (status?.code === STATUS_CODE_ERROR) {
    const msg = attrs[OBSERVATION_STATUS_MESSAGE];
    errorMessage = status.message || (typeof msg === "string" ? msg : "");
  }
  return { attributes: out, errorMessage };
};
