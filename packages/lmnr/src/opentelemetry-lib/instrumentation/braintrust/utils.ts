import { AttributeValue, HrTime, Span } from "@opentelemetry/api";

import { normalizeOtelSpanId, normalizeOtelTraceId } from "../../../utils";
import { LaminarAttributes } from "../../tracing/attributes";
import { LaminarSpanType } from "../mastra/types";
import {
  BraintrustLogPartial,
  BraintrustSpanAttributes,
} from "./types";

// Braintrust represents timestamps as fractional unix seconds (see
// `getCurrentUnixTimestamp` in braintrust/dist/index.mjs — `Date.now() / 1000`).
// Convert to OTel HrTime [seconds, nanoseconds].
export const unixSecondsToHrTime = (seconds: number): HrTime => {
  const whole = Math.floor(seconds);
  const nanos = Math.round((seconds - whole) * 1e9);
  return [whole, nanos];
};

// Map Braintrust `span_attributes.type` → Laminar span type.
// Full Braintrust value set: llm | score | function | eval | task | tool |
// automation | facet | preprocessor | classifier | review.
// `function` is Braintrust's generic "traced function" marker (what
// `@traced` / `wrapTraced` stamps), not a tool-call — default to DEFAULT.
export const mapBraintrustSpanType = (
  type: string | undefined,
): LaminarSpanType => {
  if (type === "llm") return "LLM";
  if (type === "tool") return "TOOL";
  return "DEFAULT";
};

// Braintrust's OpenAI plugin stashes `{ ...params, provider: "openai" }` under
// `metadata` so `metadata.model` is the request model the caller passed in
// (e.g. "gpt-4o-mini"). Other plugins (Anthropic, AI SDK, etc.) follow the
// same shape — see `braintrust/dist/index.mjs` openai/anthropic/aisdk plugins.
export const extractLlmMetadata = (
  metadata: Record<string, unknown> | undefined,
): {
  provider?: string;
  model?: string;
  responseModel?: string;
} => {
  if (!metadata) return {};
  const provider =
    typeof metadata.provider === "string"
      ? (metadata.provider).toLowerCase().trim()
      : undefined;
  const model =
    typeof metadata.model === "string"
      ? (metadata.model)
      : undefined;
  // Some plugins stamp `response_model` on the response path; fall back to
  // request model so Laminar's UI always has a value to render.
  const responseModel =
    typeof metadata.response_model === "string"
      ? (metadata.response_model)
      : undefined;
  return { provider, model, responseModel };
};

// Braintrust's OpenAI plugin normalizes usage into `{prompt_tokens,
// completion_tokens, tokens, prompt_cached_tokens, completion_reasoning_tokens,
// ...}` (see `parseMetricsFromUsage` + `TOKEN_NAME_MAP` / `TOKEN_PREFIX_MAP`
// in braintrust/dist/index.mjs). Anthropic / AI SDK plugins emit the same
// shape via their own usage normalizers. Map to Laminar's `gen_ai.*` semconv.
export const formatMetrics = (
  metrics: Record<string, unknown> | undefined,
): Record<string, number> => {
  if (!metrics) return {};
  const out: Record<string, number> = {};
  const num = (k: string): number | undefined =>
    typeof metrics[k] === "number" ? (metrics[k]) : undefined;

  const prompt = num("prompt_tokens");
  const completion = num("completion_tokens");
  const total = num("tokens") ?? num("total_tokens");

  if (prompt !== undefined) {
    out[LaminarAttributes.INPUT_TOKEN_COUNT] = prompt;
  }
  if (completion !== undefined) {
    out[LaminarAttributes.OUTPUT_TOKEN_COUNT] = completion;
  }
  const totalComputed =
    total ??
    ((prompt ?? 0) + (completion ?? 0) || undefined);
  if (totalComputed !== undefined && totalComputed > 0) {
    out[LaminarAttributes.TOTAL_TOKEN_COUNT] = totalComputed;
  }

  const cachedRead = num("prompt_cached_tokens");
  if (cachedRead !== undefined) {
    out["gen_ai.usage.cache_read_input_tokens"] = cachedRead;
  }
  const cachedWrite = num("prompt_cache_creation_tokens");
  if (cachedWrite !== undefined) {
    out["gen_ai.usage.cache_creation_input_tokens"] = cachedWrite;
  }
  const reasoning = num("completion_reasoning_tokens");
  if (reasoning !== undefined) {
    out["gen_ai.usage.reasoning_tokens"] = reasoning;
  }

  if (typeof metrics.time_to_first_token === "number") {
    out["gen_ai.server.time_to_first_token"] =
      metrics.time_to_first_token;
  }

  return out;
};

export const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  // `JSON.stringify` returns the primitive `undefined` for `undefined`
  // and for bare functions — we must return a string unconditionally, so
  // fall back to the empty string for those cases.
  if (value === undefined || typeof value === "function") return "";
  try {
    const out = JSON.stringify(value);
    return out ?? "";
  } catch {
    return "[unserializable]";
  }
};

export const toAttributeValue = (
  value: unknown,
): AttributeValue | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) {
      return value;
    }
    if (value.every((v) => typeof v === "number")) {
      return value;
    }
    if (value.every((v) => typeof v === "boolean")) {
      return value;
    }
  }
  return serializeJSON(value);
};

// Merge a partial log into an accumulator. Braintrust's `logInternal` writes
// each `span.log(...)` call as a merge event (`IS_MERGE_FIELD = true`), so
// later calls augment earlier ones. Mirror that so we hand a full LLM record
// to the OTel span at end-time.
export const mergeLogPartial = (
  target: BraintrustLogPartial,
  source: BraintrustLogPartial,
): void => {
  if (source.input !== undefined) target.input = source.input;
  if (source.output !== undefined) target.output = source.output;
  if (source.expected !== undefined) target.expected = source.expected;
  if (source.error !== undefined) target.error = source.error;
  if (source.tags !== undefined) target.tags = source.tags;
  if (source.scores) {
    target.scores = { ...(target.scores ?? {}), ...source.scores };
  }
  if (source.metadata) {
    target.metadata = { ...(target.metadata ?? {}), ...source.metadata };
  }
  if (source.metrics) {
    target.metrics = { ...(target.metrics ?? {}), ...source.metrics };
  }
  if (source.span_attributes) {
    target.span_attributes = {
      ...(target.span_attributes ?? {}),
      ...source.span_attributes,
    };
  }
};

// Pull the display name from Braintrust's span_attributes snapshot, with a
// fallback to "span". Braintrust's SpanImpl always populates this in its
// constructor's `internalData`.
export const extractSpanName = (
  attrs: BraintrustSpanAttributes | undefined,
  fallback?: string,
): string => {
  if (attrs && typeof attrs.name === "string" && attrs.name.length > 0) {
    return attrs.name;
  }
  return fallback ?? "span";
};

// Read a string[] attribute off an OTel span (or our LaminarSpan wrapper).
// Both OTel v1 ReadableSpan and LaminarSpan expose an `attributes` map getter;
// we only accept the value when it's an array of strings so callers don't have
// to re-check the shape.
export const readStringArrayAttribute = (
  span: Span | undefined,
  key: string,
): string[] | undefined => {
  if (!span) return undefined;
  const attrs = (span as unknown as { attributes?: Record<string, unknown> })
    .attributes;
  if (!attrs) return undefined;
  const value = attrs[key];
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
    return value;
  }
  return undefined;
};

// FNV-1a 32-bit, repeated / mixed to reach `hexChars`. Not crypto — just a
// stable, collision-resistant-enough mapping for trace/span ids derived from
// Braintrust's own base58 ids. Avoids a `crypto` import to keep this module
// usable in edge runtimes.
export const hashToHex = (input: string, hexChars: number): string => {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x9e3779b1) >>> 0;
  }
  let out = "";
  let x = a;
  let y = b;
  while (out.length < hexChars) {
    out += x.toString(16).padStart(8, "0");
    if (out.length >= hexChars) break;
    out += y.toString(16).padStart(8, "0");
    // Re-mix so the next round isn't just a repeat.
    x = Math.imul(x ^ (y + 0x9e3779b1), 0x85ebca6b) >>> 0;
    y = Math.imul(y ^ (x + 0xc2b2ae35), 0xcc9e2d51) >>> 0;
  }
  return out.slice(0, hexChars);
};

// Braintrust span ids are ~22-char base58 (ksuid-like) — hash them down to
// a deterministic 16-hex OTel span id so every Braintrust span under one
// rootSpanId nests under the same OTel trace, and sibling spans get distinct
// ids.
export const braintrustToOtelSpanId = (bt: string): string =>
  normalizeOtelSpanId(hashToHex(bt, 16));

export const braintrustToOtelTraceId = (bt: string): string =>
  normalizeOtelTraceId(hashToHex(bt, 32));

// OTel GenAI semconv part type — `{type: "text"|"thinking"|"tool_call"|
// "tool_call_response", ...}`. The backend (`app-server/src/traces/spans.rs`)
// preserves these verbatim and the frontend parser in
// `frontend/lib/spans/types/gen-ai.ts` maps each part to the appropriate
// ModelMessage shape.
export interface GenAIPart {
  type: "text" | "thinking" | "tool_call" | "tool_call_response";
  content?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
}

export interface GenAIMessage {
  role: string;
  parts: GenAIPart[];
  finish_reason?: string;
}

// Parse OpenAI's tool-call `function.arguments` — which is always a JSON string
// — into its structured form so it lands as an object under `arguments` rather
// than a stringified blob. Leave non-JSON-parseable values as strings so the
// backend still has something to render.
const parseJsonOrRaw = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// Convert a single Braintrust-shaped OpenAI ChatCompletion message (including
// tool-result messages: `{role: "tool", tool_call_id, content}`) into a GenAI
// semconv `{role, parts}` entry. Returns null if the input isn't object-shaped.
const chatMessageToGenAI = (msg: unknown): GenAIMessage | null => {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "user";
  const parts: GenAIPart[] = [];

  if (role === "tool") {
    const id = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
    parts.push({
      type: "tool_call_response",
      id,
      result: parseJsonOrRaw(m.content),
    });
    return { role, parts };
  }

  const content = m.content;
  if (typeof content === "string" && content.length > 0) {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    // OpenAI multimodal content is an array of `{type: "text"|"image_url"|...}`;
    // the only one we can round-trip into GenAI semconv without an ontology is
    // text. Non-text parts become a stringified fallback text part so nothing is
    // silently lost.
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push({ type: "text", content: p.text });
      } else {
        parts.push({ type: "text", content: serializeJSON(p) });
      }
    }
  }

  const toolCalls = m.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, unknown> | undefined;
      parts.push({
        type: "tool_call",
        id: typeof tc.id === "string" ? tc.id : undefined,
        name: typeof fn?.name === "string" ? fn.name : undefined,
        arguments: parseJsonOrRaw(fn?.arguments),
      });
    }
  }

  return { role, parts };
};

// Braintrust's OpenAI plugin passes `input` = the full messages array exactly
// as the user sent it to `openai.chat.completions.create` (see `extractInput`
// in `braintrust/dist/index.mjs` openai plugin: `const { messages, ...rest }`).
// Anthropic / AI SDK plugins follow similar message-array shapes.
export const inputMessagesToGenAI = (input: unknown): GenAIMessage[] => {
  if (!Array.isArray(input)) return [];
  const out: GenAIMessage[] = [];
  for (const msg of input) {
    const converted = chatMessageToGenAI(msg);
    if (converted) out.push(converted);
  }
  return out;
};

// Braintrust's OpenAI plugin logs `output = result.choices` — an array of
// `{index, message: {role, content, tool_calls}, finish_reason}`. Collapse the
// choices into the assistant-side GenAI messages array; most plugins only have
// one choice, but we preserve all of them for parity.
export const outputChoicesToGenAI = (output: unknown): GenAIMessage[] => {
  if (!Array.isArray(output)) return [];
  const out: GenAIMessage[] = [];
  for (const choice of output) {
    if (!choice || typeof choice !== "object") continue;
    const c = choice as Record<string, unknown>;
    const converted = chatMessageToGenAI(c.message);
    if (!converted) continue;
    if (typeof c.finish_reason === "string") {
      converted.finish_reason = c.finish_reason;
    }
    out.push(converted);
  }
  return out;
};
