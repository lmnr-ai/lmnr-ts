import { ASSOC_PREFIX } from "./tracer.js";
import type { Json, PiAssistantMessage, PiUsage } from "./types.js";
import { extractText, jsonDumpsTruncated } from "./util.js";

// ----------------- Attribute mapping (wayfinder ticket 5) -----------------
// pi payloads → Laminar `lmnr.*` / OTel `gen_ai.*` attributes. Field-name
// divergences from Anthropic-raw are handled here (usage.input vs input_tokens;
// `toolCall{arguments}` blocks; tool result arrives on the event, not content).

/**
 * Infer the model vendor for `gen_ai.system` from pi's `model` string.
 * pi models look like `us.anthropic.claude-opus-4-8`, `us.openai.gpt-5.5`,
 * `amazon-bedrock/qwen.qwen3-coder-...`. We look for a known vendor token,
 * falling back to `provider`, then "unknown".
 */
const KNOWN_VENDORS = [
  "anthropic", "openai", "google", "meta", "mistral", "cohere", "qwen", "deepseek", "amazon",
];

export function inferVendor(model: string | undefined, provider: string | undefined): string {
  const haystack = (model ?? "").toLowerCase();
  for (const vendor of KNOWN_VENDORS) {
    if (haystack.includes(vendor)) {
      return vendor;
    }
  }
  return (provider ?? "").toLowerCase() || "unknown";
}

/** Map pi `usage` token fields to gen_ai.usage.* (kept only when > 0, matching CC). */
export function mapUsageTokens(usage: PiUsage | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!usage) {
    return out;
  }
  const pairs: [string, number | undefined][] = [
    ["gen_ai.usage.input_tokens", usage.input],
    ["gen_ai.usage.output_tokens", usage.output],
    ["gen_ai.usage.cache_read_input_tokens", usage.cacheRead],
    ["gen_ai.usage.cache_creation_input_tokens", usage.cacheWrite],
  ];
  for (const [key, value] of pairs) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    out["llm.usage.total_tokens"] = usage.totalTokens;
  }
  return out;
}

/**
 * Map pi's precomputed `usage.cost` to the SDK's canonical cost attributes
 * (`gen_ai.usage.cost` / `input_cost` / `output_cost`, per lmnr-ts
 * `LaminarAttributes`). pi hands us the authoritative cost, so we emit it
 * directly rather than relying on Laminar deriving cost from tokens — the
 * derivation only works for models Laminar has pricing for, whereas pi's
 * number is correct for every provider/model.
 */
export function mapUsageCost(usage: PiUsage | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const cost = usage?.cost;
  if (!cost) {
    return out;
  }
  const pairs: [string, number | undefined][] = [
    ["gen_ai.usage.cost", cost.total],
    ["gen_ai.usage.input_cost", cost.input],
    ["gen_ai.usage.output_cost", cost.output],
  ];
  for (const [key, value] of pairs) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

/** Represent a pi assistant message's content as a single gen_ai output message. */
export function buildOutputMessage(message: PiAssistantMessage): Json {
  const text = extractText(message.content);
  const toolCalls: Json[] = [];
  for (const block of message.content ?? []) {
    if (block && typeof block === "object" && block.type === "toolCall") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments ?? null });
    }
  }
  const out: Json = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls;
  }
  return out;
}

/** Attributes for an LLM span, from a pi assistant message. */
export function buildLlmAttributes(
  message: PiAssistantMessage,
  inputMessages: Json[] | null,
): Record<string, Json> {
  const attrs: Record<string, Json> = {
    "gen_ai.system": inferVendor(message.model, message.provider),
  };
  if (message.provider) {
    attrs["gen_ai.provider.name"] = message.provider;
  }
  if (message.model) {
    attrs["gen_ai.request.model"] = message.model;
    attrs["gen_ai.response.model"] = message.model;
  }
  if (message.api) {
    attrs["gen_ai.request.api"] = message.api;
  }
  if (message.stopReason) {
    attrs["gen_ai.response.finish_reasons"] = [message.stopReason];
  }
  if (inputMessages) {
    attrs["gen_ai.input.messages"] = jsonDumpsTruncated(inputMessages);
  }
  attrs["gen_ai.output.messages"] = jsonDumpsTruncated([buildOutputMessage(message)]);

  Object.assign(attrs, mapUsageTokens(message.usage));
  Object.assign(attrs, mapUsageCost(message.usage));
  return attrs;
}

/** Association-property attributes for the run root span. */
export function buildRootAssociation(
  sessionId: string,
  userId: string | null,
  cwd?: string,
): Record<string, Json> {
  const attrs: Record<string, Json> = {
    [`${ASSOC_PREFIX}.session_id`]: sessionId,
    [`${ASSOC_PREFIX}.metadata.source`]: "pi",
  };
  if (userId) {
    attrs[`${ASSOC_PREFIX}.user_id`] = userId;
  }
  if (cwd) {
    attrs[`${ASSOC_PREFIX}.metadata.cwd`] = cwd;
  }
  return attrs;
}
