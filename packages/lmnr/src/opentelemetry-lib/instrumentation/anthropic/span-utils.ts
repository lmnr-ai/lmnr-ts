/** Utility functions for setting span attributes on Anthropic instrumentation spans. */

import type { Span } from "@opentelemetry/api";

import type {
  CompleteStreamingResponse,
  InputMessage,
  OutputMessage,
} from "./types";

/**
 * Set a span attribute only if the value is non-null/undefined and non-empty.
 */
export const setSpanAttribute = (
  span: Span,
  name: string,
  value: unknown,
): void => {
  if (value !== null && value !== undefined && value !== "") {
    span.setAttribute(name, value as any);
  }
};

/**
 * Convert message content to a serializable format.
 * For strings, returns as-is. For arrays, converts each item via modelAsDict.
 */
const processContentForMessage = (content: unknown): unknown => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => modelAsDict(item));
  }
  return content;
};

/**
 * Convert a model object to a plain dict. Handles pydantic-like objects
 * and plain dicts.
 */
export const modelAsDict = (model: unknown): Record<string, unknown> => {
  if (model === null || model === undefined) {
    return {};
  }
  if (typeof model === "object" && !Array.isArray(model)) {
    // Check for toJSON method (Anthropic SDK objects have this)
    if ("toJSON" in model && typeof (model as any).toJSON === "function") {
      return (model as any).toJSON() as Record<string, unknown>;
    }
    return { ...model } as Record<string, unknown>;
  }
  return {};
};

/**
 * Build input messages list from request kwargs, matching Python's format.
 * Produces `gen_ai.input.messages` attribute value.
 */
export const buildInputMessages = (
  params: Record<string, any>,
): InputMessage[] => {
  const messages: InputMessage[] = [];

  if (params.prompt !== undefined) {
    // Legacy completions API
    messages.push({ role: "user", content: params.prompt });
    return messages;
  }

  if (params.messages !== undefined) {
    // Add system message if present
    if (params.system) {
      const systemContent = processContentForMessage(params.system);
      messages.push({ role: "system", content: systemContent as any });
    }

    // Add all user/assistant messages
    for (const message of params.messages) {
      const msg: Record<string, unknown> = { ...message };
      const content = msg.content;
      if (content !== undefined) {
        msg.content = processContentForMessage(content);
      }
      messages.push(msg as unknown as InputMessage);
    }
  }

  return messages;
};

/**
 * Extract the JSON schema from Anthropic `output_config` kwargs.
 *
 * Both `messages.create` and `messages.parse` accept
 * `output_config={format: {type: "json_schema", schema: {...}}}`. The
 * `zodOutputFormat` and `jsonSchemaOutputFormat` helpers produce exactly
 * this shape. Returns the serialized JSON schema, or null if none is
 * present or cannot be serialized.
 */
export const extractStructuredOutputSchema = (
  params: Record<string, any>,
): string | null => {
  const outputConfig = params.output_config;
  if (outputConfig && typeof outputConfig === "object") {
    const fmt = outputConfig.format;
    if (fmt && typeof fmt === "object" && fmt.schema !== undefined) {
      try {
        return JSON.stringify(fmt.schema);
      } catch {
        return null;
      }
    }
  }
  return null;
};

/**
 * Set input attributes on a span from request params.
 */
export const setInputAttributes = (
  span: Span,
  params: Record<string, any>,
  traceContent: boolean,
): void => {
  setSpanAttribute(span, "gen_ai.request.model", params.model);
  setSpanAttribute(
    span,
    "gen_ai.request.max_tokens",
    params.max_tokens ?? params.max_tokens_to_sample,
  );
  setSpanAttribute(span, "gen_ai.request.temperature", params.temperature);
  setSpanAttribute(span, "gen_ai.request.top_p", params.top_p);
  setSpanAttribute(span, "gen_ai.request.top_k", params.top_k);
  setSpanAttribute(
    span,
    "gen_ai.request.frequency_penalty",
    params.frequency_penalty,
  );
  setSpanAttribute(
    span,
    "gen_ai.request.presence_penalty",
    params.presence_penalty,
  );
  setSpanAttribute(span, "llm.is_streaming", params.stream);
  setSpanAttribute(span, "anthropic.request.service_tier", params.service_tier);

  if (traceContent) {
    const inputMessages = buildInputMessages(params);
    if (inputMessages.length > 0) {
      setSpanAttribute(
        span,
        "gen_ai.input.messages",
        JSON.stringify(inputMessages),
      );
    }

    if (params.tools) {
      setSpanAttribute(
        span,
        "gen_ai.tool.definitions",
        JSON.stringify(params.tools),
      );
    }
  }

  const schemaJson = extractStructuredOutputSchema(params);
  if (schemaJson !== null) {
    setSpanAttribute(
      span,
      "gen_ai.request.structured_output_schema",
      schemaJson,
    );
  }
};

/**
 * Build the output messages list from a non-streaming Anthropic response.
 * Returns a list with a single message dict matching Python's format.
 */
export const buildOutputFromResponse = (
  response: Record<string, any>,
): OutputMessage[] => {
  const result: OutputMessage = {
    role: response.role ?? "assistant",
    content: [],
  };

  const stopReason = response.stop_reason;
  if (stopReason) {
    result.stop_reason = stopReason;
  }

  if (response.completion) {
    result.content.push({
      type: "text",
      text: response.completion,
    });
  } else if (response.content) {
    for (const block of response.content) {
      result.content.push(modelAsDict(block) as any);
    }
  }

  return [result];
};

/**
 * Set response attributes on a span from a non-streaming response.
 */
export const setResponseAttributes = (
  span: Span,
  response: Record<string, any>,
  traceContent: boolean,
): void => {
  setSpanAttribute(span, "gen_ai.response.model", response.model);
  setSpanAttribute(span, "gen_ai.response.id", response.id);

  const usage = response.usage;
  if (usage) {
    const promptTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

    const inputTokens = promptTokens + cacheReadTokens + cacheCreationTokens;
    setSpanAttribute(span, "gen_ai.usage.input_tokens", inputTokens);
    setSpanAttribute(span, "gen_ai.usage.output_tokens", outputTokens);

    setSpanAttribute(
      span,
      "gen_ai.usage.cache_read_input_tokens",
      cacheReadTokens,
    );
    setSpanAttribute(
      span,
      "gen_ai.usage.cache_creation_input_tokens",
      cacheCreationTokens,
    );

    if (usage.service_tier) {
      setSpanAttribute(
        span,
        "anthropic.response.service_tier",
        usage.service_tier,
      );
    }
  }

  if (traceContent) {
    const output = buildOutputFromResponse(response);
    setSpanAttribute(span, "gen_ai.output.messages", JSON.stringify(output));
  }
};

/**
 * Build output messages from streaming events.
 * Matches Python's set_streaming_response_attributes.
 */
export const buildStreamingOutput = (
  events: CompleteStreamingResponse["events"],
): OutputMessage[] => {
  const result: OutputMessage = {
    role: "assistant",
    content: [],
  };

  let finishReason: string | null = null;

  for (const event of events) {
    if (event.finish_reason) {
      finishReason = event.finish_reason;
    }

    if (event.type === "thinking") {
      result.content.push({
        type: "thinking",
        thinking: event.text ?? "",
      });
    } else if (event.type === "tool_use") {
      let toolInput: string | Record<string, unknown> = event.input ?? "";
      // input may be a stringified JSON from streaming, try to parse
      if (typeof toolInput === "string") {
        try {
          toolInput = JSON.parse(toolInput) as Record<string, unknown>;
        } catch {
          // keep as string
        }
      }
      result.content.push({
        type: "tool_use",
        id: event.id ?? "",
        name: event.name ?? "",
        input: toolInput,
      });
    } else {
      // text block
      const text = event.text ?? "";
      if (text) {
        result.content.push({
          type: "text",
          text,
        });
      }
    }
  }

  if (finishReason) {
    result.stop_reason = finishReason;
  }

  return [result];
};

/**
 * Set streaming response attributes on a span.
 */
export const setStreamingResponseAttributes = (
  span: Span,
  completeResponse: CompleteStreamingResponse,
  traceContent: boolean,
): void => {
  setSpanAttribute(span, "gen_ai.response.id", completeResponse.id);
  setSpanAttribute(span, "gen_ai.response.model", completeResponse.model);
  setSpanAttribute(
    span,
    "anthropic.response.service_tier",
    completeResponse.service_tier,
  );

  const usage = completeResponse.usage;
  if (usage) {
    const promptTokens = usage.input_tokens ?? 0;
    const completionTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

    const inputTokens = promptTokens + cacheReadTokens + cacheCreationTokens;

    setSpanAttribute(span, "gen_ai.usage.input_tokens", inputTokens);
    setSpanAttribute(span, "gen_ai.usage.output_tokens", completionTokens);
    setSpanAttribute(
      span,
      "gen_ai.usage.cache_read_input_tokens",
      cacheReadTokens,
    );
    setSpanAttribute(
      span,
      "gen_ai.usage.cache_creation_input_tokens",
      cacheCreationTokens,
    );
  }

  if (traceContent && completeResponse.events.length > 0) {
    const output = buildStreamingOutput(completeResponse.events);
    setSpanAttribute(span, "gen_ai.output.messages", JSON.stringify(output));
  }
};
