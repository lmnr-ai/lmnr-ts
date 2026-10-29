import { SpanStatusCode } from "@opentelemetry/api";

import { toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../shared/utils";

export const ANTHROPIC_SYSTEM = "anthropic";

/**
 * Accumulated state of a streamed response, built from its raw stream events.
 */
export type StreamState = {
  id?: string;
  model?: string;
  serviceTier?: string;
  usage: Record<string, any>;
  stopReason?: string;
  blocks: Record<string, any>[];
  // Legacy completions stream `{ completion, stop_reason, model }` chunks.
  completion: string;
};

export const createStreamState = (): StreamState => ({
  usage: {},
  blocks: [],
  completion: "",
});

const extractStructuredOutputSchema = (params: any): string | undefined => {
  // `output_format` is the older parameter; a raw dict may be the bare schema.
  const outputFormat = params?.output_format;
  if (outputFormat && typeof outputFormat === "object") {
    return toJson(outputFormat.schema ?? outputFormat);
  }
  // `zodOutputFormat()` and friends produce `{ type, schema, parse }`.
  const schema = params?.output_config?.format?.schema;
  if (schema && typeof schema === "object") {
    return toJson(schema);
  }
  return undefined;
};

const buildInputMessages = (params: any): unknown[] | undefined => {
  if (params?.prompt !== undefined && params?.prompt !== null) {
    // Legacy completions API
    return [{ role: "user", content: params.prompt }];
  }
  if (!Array.isArray(params?.messages)) return undefined;

  const messages: unknown[] = [];
  if (params.system) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push(...params.messages);
  return messages;
};

export const setRequestAttributes = (
  span: LaminarSpan,
  params: any,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.system", ANTHROPIC_SYSTEM);
  safeSetAttribute(span, "gen_ai.request.model", params?.model);
  safeSetAttribute(
    span,
    "gen_ai.request.max_tokens",
    params?.max_tokens ?? params?.max_tokens_to_sample,
  );
  safeSetAttribute(span, "gen_ai.request.temperature", params?.temperature);
  safeSetAttribute(span, "gen_ai.request.top_p", params?.top_p);
  safeSetAttribute(
    span,
    "gen_ai.request.frequency_penalty",
    params?.frequency_penalty,
  );
  safeSetAttribute(
    span,
    "gen_ai.request.presence_penalty",
    params?.presence_penalty,
  );
  safeSetAttribute(span, "llm.is_streaming", params?.stream);
  safeSetAttribute(
    span,
    "anthropic.request.service_tier",
    params?.service_tier,
  );

  if (traceContent) {
    safeSetAttribute(
      span,
      GEN_AI_INPUT_MESSAGES,
      toJson(buildInputMessages(params)),
    );
    safeSetAttribute(span, GEN_AI_TOOL_DEFINITIONS, toJson(params?.tools));
  }

  safeSetAttribute(
    span,
    "gen_ai.request.structured_output_schema",
    extractStructuredOutputSchema(params),
  );
};

const setUsageAttributes = (
  span: LaminarSpan,
  usage: any,
  includeTotal: boolean,
): void => {
  if (!usage || typeof usage !== "object" || !Object.keys(usage).length) {
    return;
  }
  const promptTokens = usage.input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  // Anthropic reports cached tokens separately from `input_tokens`.
  const inputTokens = promptTokens + cacheReadTokens + cacheCreationTokens;

  span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
  if (includeTotal) {
    span.setAttribute("llm.usage.total_tokens", inputTokens + outputTokens);
  }
  span.setAttribute("gen_ai.usage.cache_read_input_tokens", cacheReadTokens);
  span.setAttribute(
    "gen_ai.usage.cache_creation_input_tokens",
    cacheCreationTokens,
  );
};

/**
 * Response attributes for a non-streaming `Message` (or legacy `Completion`).
 */
export const setResponseAttributes = (
  span: LaminarSpan,
  response: any,
  traceContent: boolean,
): void => {
  if (!response || typeof response !== "object") return;
  safeSetAttribute(span, "gen_ai.response.model", response.model);
  safeSetAttribute(span, "gen_ai.response.id", response.id);
  safeSetAttribute(
    span,
    "anthropic.response.service_tier",
    response.usage?.service_tier,
  );
  setUsageAttributes(span, response.usage, true);

  if (traceContent) {
    const output: Record<string, any> = {
      role: response.role ?? "assistant",
      content: [],
    };
    if (response.stop_reason) {
      output.stop_reason = response.stop_reason;
    }
    if (response.completion) {
      output.content.push({ type: "text", text: response.completion });
    } else if (Array.isArray(response.content)) {
      output.content.push(...response.content);
    }
    safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson([output]));
  }

  span.setStatus({ code: SpanStatusCode.OK });
};

const mergeUsage = (state: StreamState, usage: any): void => {
  if (!usage || typeof usage !== "object") return;
  // Usage in `message_delta` is cumulative, so values replace rather than
  // add up. Nulls would wipe what `message_start` reported.
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null && value !== undefined) {
      state.usage[key] = value;
    }
  }
};

/**
 * Fold one raw stream event (`RawMessageStreamEvent`, or a legacy completion
 * chunk) into the accumulated state.
 */
export const processStreamEvent = (state: StreamState, event: any): void => {
  switch (event?.type) {
    case "message_start": {
      const message = event.message ?? {};
      state.id = message.id;
      state.model = message.model;
      mergeUsage(state, message.usage);
      state.serviceTier = message.usage?.service_tier ?? undefined;
      break;
    }
    case "content_block_start": {
      const block = { ...event.content_block };
      if ("input" in block) {
        // Tool input arrives as `input_json_delta` fragments.
        block.input = "";
      }
      state.blocks[event.index] = block;
      break;
    }
    case "content_block_delta": {
      const block = state.blocks[event.index];
      const delta = event.delta ?? {};
      if (!block) break;
      if (delta.type === "text_delta") {
        block.text = (block.text ?? "") + (delta.text ?? "");
      } else if (delta.type === "thinking_delta") {
        block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
      } else if (delta.type === "input_json_delta") {
        block.input = (block.input ?? "") + (delta.partial_json ?? "");
      }
      break;
    }
    case "message_delta":
      if (event.delta?.stop_reason) {
        state.stopReason = event.delta.stop_reason;
      }
      mergeUsage(state, event.usage);
      break;
    case "completion":
      state.id = event.id ?? state.id;
      state.model = event.model ?? state.model;
      state.completion += event.completion ?? "";
      if (event.stop_reason) {
        state.stopReason = event.stop_reason;
      }
      break;
  }
};

const parseToolInput = (input: unknown): unknown => {
  if (typeof input !== "string") return input;
  if (input === "") return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
};

const buildStreamedContent = (state: StreamState): Record<string, any>[] => {
  if (state.completion) {
    return [{ type: "text", text: state.completion }];
  }
  const content: Record<string, any>[] = [];
  for (const block of state.blocks) {
    if (!block) continue;
    if (block.type === "text") {
      if (block.text) {
        content.push({ type: "text", text: block.text });
      }
    } else if (block.type === "thinking") {
      content.push({ type: "thinking", thinking: block.thinking ?? "" });
    } else if ("input" in block) {
      // `tool_use`, `server_tool_use`, `mcp_tool_use`
      content.push({ ...block, input: parseToolInput(block.input) });
    } else {
      content.push(block);
    }
  }
  return content;
};

export const setStreamingResponseAttributes = (
  span: LaminarSpan,
  state: StreamState,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.response.id", state.id);
  safeSetAttribute(span, "gen_ai.response.model", state.model);
  safeSetAttribute(
    span,
    "anthropic.response.service_tier",
    state.usage.service_tier ?? state.serviceTier,
  );
  setUsageAttributes(span, state.usage, false);

  if (traceContent) {
    const output: Record<string, any> = {
      role: "assistant",
      content: buildStreamedContent(state),
    };
    if (state.stopReason) {
      output.stop_reason = state.stopReason;
    }
    safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson([output]));
  }
};
