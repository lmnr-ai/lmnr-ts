import { AttributeValue, HrTime } from "@opentelemetry/api";

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
  try {
    return JSON.stringify(value);
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
