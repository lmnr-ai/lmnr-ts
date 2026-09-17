import { SpanStatusCode } from "@opentelemetry/api";

import { LaminarSpan } from "../../tracing/span";

export type ResourceKind = "chat" | "responses" | "embeddings";

const TERMINAL_RESPONSE_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

// A `responses` result in one of these states carries no usable completion.
const ERROR_RESPONSE_STATUSES = new Set(["failed", "incomplete"]);

const safeSetAttribute = (
  span: LaminarSpan,
  key: string,
  value: unknown,
): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && value.length === 0) return;
  span.setAttribute(key, value as any);
};

export const recordError = (span: LaminarSpan, error: unknown): void => {
  span.setAttribute(
    "error.type",
    (error as Error)?.constructor?.name ?? "Error",
  );
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
};

export const isAsyncIterable = (value: unknown): value is AsyncIterable<any> =>
  typeof (value as any)?.[Symbol.asyncIterator] === "function";

export const responsesInputMessages = (request: any): any[] => {
  const messages: any[] = [];
  if (request?.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }
  if (typeof request?.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else if (Array.isArray(request?.input)) {
    messages.push(...request.input);
  }
  return messages;
};

const structuredOutputSchema = (kind: ResourceKind, request: any): unknown => {
  const format =
    kind === "chat" ? request?.responseFormat : request?.text?.format;
  if (format?.type !== "json_schema") return undefined;
  return kind === "chat" ? format.jsonSchema?.schema : format.schema;
};

/**
 * `input` is either one document or a batch of them. A flat array of numbers is
 * a single token-id sequence, not a batch — the API returns one embedding for it.
 */
const embeddingsInputMessages = (input: unknown): unknown[] => {
  const isBatch =
    Array.isArray(input) && !(input.length > 0 && typeof input[0] === "number");
  return (isBatch ? input : [input]).map((content) => ({ content }));
};

export const setRequestAttributes = (
  span: LaminarSpan,
  kind: ResourceKind,
  request: any,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.request.model", request?.model);
  safeSetAttribute(span, "llm.user", request?.user);

  if (kind === "embeddings") {
    if (traceContent && request?.input !== undefined) {
      safeSetAttribute(
        span,
        "gen_ai.input.messages",
        JSON.stringify(embeddingsInputMessages(request.input)),
      );
    }
    return;
  }

  safeSetAttribute(span, "gen_ai.request.temperature", request?.temperature);
  safeSetAttribute(span, "gen_ai.request.top_p", request?.topP);
  safeSetAttribute(
    span,
    "gen_ai.request.frequency_penalty",
    request?.frequencyPenalty,
  );
  safeSetAttribute(
    span,
    "gen_ai.request.presence_penalty",
    request?.presencePenalty,
  );
  // `chat` takes a flat `reasoningEffort`, `responses` nests it under `reasoning`.
  safeSetAttribute(
    span,
    "gen_ai.request.reasoning_effort",
    request?.reasoningEffort ?? request?.reasoning?.effort,
  );
  safeSetAttribute(
    span,
    "gen_ai.request.max_tokens",
    kind === "chat" ? request?.maxTokens : request?.maxOutputTokens,
  );
  const schema = structuredOutputSchema(kind, request);
  if (schema) {
    safeSetAttribute(
      span,
      "gen_ai.request.structured_output_schema",
      JSON.stringify(schema),
    );
  }
  if (request?.stream) {
    safeSetAttribute(span, "llm.is_streaming", true);
  }

  if (!traceContent) return;
  if (Array.isArray(request?.tools) && request.tools.length > 0) {
    safeSetAttribute(
      span,
      "gen_ai.tool.definitions",
      JSON.stringify(request.tools),
    );
  }
  const messages =
    kind === "chat" ? request?.messages : responsesInputMessages(request);
  if (Array.isArray(messages) && messages.length > 0) {
    safeSetAttribute(span, "gen_ai.input.messages", JSON.stringify(messages));
  }
};

const setUsageAttributes = (
  span: LaminarSpan,
  usage: any,
  inputKey: string,
  outputKey: string,
  inputCostKey: string,
  outputCostKey: string,
): void => {
  if (!usage) return;
  safeSetAttribute(span, "gen_ai.usage.input_tokens", usage[inputKey]);
  safeSetAttribute(span, "gen_ai.usage.output_tokens", usage[outputKey]);
  safeSetAttribute(span, "llm.usage.total_tokens", usage.totalTokens);

  const inputDetails = usage[`${inputKey}Details`];
  safeSetAttribute(
    span,
    "gen_ai.usage.cache_read_input_tokens",
    inputDetails?.cachedTokens,
  );
  safeSetAttribute(
    span,
    "gen_ai.usage.cache_creation_input_tokens",
    inputDetails?.cacheWriteTokens,
  );
  safeSetAttribute(
    span,
    "gen_ai.usage.reasoning_tokens",
    usage[`${outputKey}Details`]?.reasoningTokens,
  );

  safeSetAttribute(span, "gen_ai.usage.cost", usage.cost);
  safeSetAttribute(
    span,
    "gen_ai.usage.input_cost",
    usage.costDetails?.[inputCostKey],
  );
  safeSetAttribute(
    span,
    "gen_ai.usage.output_cost",
    usage.costDetails?.[outputCostKey],
  );
};

/** Message to fail the span with, or `undefined` if the response succeeded. */
const responsesErrorMessage = (response: any): string | undefined => {
  if (!ERROR_RESPONSE_STATUSES.has(response?.status)) return undefined;
  return (
    response.error?.message ??
    response.incompleteDetails?.reason ??
    response.status
  );
};

export const setResponseAttributes = (
  span: LaminarSpan,
  kind: ResourceKind,
  response: any,
  traceContent: boolean,
): void => {
  if (!response) return;
  safeSetAttribute(span, "gen_ai.response.id", response.id);
  safeSetAttribute(span, "gen_ai.response.model", response.model);

  if (kind === "responses") {
    setUsageAttributes(
      span,
      response.usage,
      "inputTokens",
      "outputTokens",
      "upstreamInferenceInputCost",
      "upstreamInferenceOutputCost",
    );
    const error = responsesErrorMessage(response);
    if (error) {
      span.setAttribute("error.type", response.status);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    }
  } else {
    // `embeddings` usage carries no completion counters, but the keys it does
    // carry match `chat`.
    setUsageAttributes(
      span,
      response.usage,
      "promptTokens",
      "completionTokens",
      "upstreamInferencePromptCost",
      "upstreamInferenceCompletionsCost",
    );
  }

  if (!traceContent || kind === "embeddings") return;
  const output = kind === "chat" ? response.choices : response.output;
  if (Array.isArray(output) && output.length > 0) {
    safeSetAttribute(span, "gen_ai.output.messages", JSON.stringify(output));
  }
};

const aggregateChatChunks = (chunks: any[]): any => {
  const result: any = { id: undefined, model: undefined, usage: undefined };
  const choices = new Map<number, any>();
  const toolCalls = new Map<number, Map<number, any>>();

  for (const chunk of chunks) {
    result.id ??= chunk?.id;
    result.model ??= chunk?.model;
    if (chunk?.usage) result.usage = chunk.usage;

    for (const choice of chunk?.choices ?? []) {
      const index = choice.index ?? 0;
      if (!choices.has(index)) {
        choices.set(index, {
          index,
          message: { role: "assistant", content: "" },
          finishReason: undefined,
        });
      }
      const accumulated = choices.get(index);
      const delta = choice.delta ?? {};
      if (delta.role) accumulated.message.role = delta.role;
      if (delta.content) accumulated.message.content += delta.content;
      for (const call of delta.toolCalls ?? []) {
        if (!toolCalls.has(index)) toolCalls.set(index, new Map());
        const calls = toolCalls.get(index)!;
        const callIndex = call.index ?? 0;
        if (!calls.has(callIndex)) {
          calls.set(callIndex, {
            id: undefined,
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const slot = calls.get(callIndex);
        slot.id ??= call.id;
        slot.function.name += call.function?.name ?? "";
        slot.function.arguments += call.function?.arguments ?? "";
      }
      if (choice.finishReason) accumulated.finishReason = choice.finishReason;
    }
  }

  for (const [index, calls] of toolCalls) {
    choices.get(index).message.toolCalls = [...calls.keys()]
      .sort((a, b) => a - b)
      .map((key) => calls.get(key));
  }
  result.choices = [...choices.keys()]
    .sort((a, b) => a - b)
    .map((key) => choices.get(key));
  return result;
};

const responseFromStreamEvents = (events: any[]): any => {
  for (let i = events.length - 1; i >= 0; i--) {
    if (TERMINAL_RESPONSE_EVENTS.has(events[i]?.type)) {
      return events[i].response;
    }
  }
  return undefined;
};

/**
 * Replaces the stream's async iterator so the span is finalized once the
 * consumer finishes (or abandons) iteration. The stream object is returned as-is.
 */
export const wrapStream = <T extends AsyncIterable<any>>(
  span: LaminarSpan,
  kind: ResourceKind,
  stream: T,
  traceContent: boolean,
): T => {
  const originalIterator = stream[Symbol.asyncIterator].bind(stream);

  async function* wrapper(): AsyncGenerator<any> {
    const chunks: any[] = [];
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        chunks.push(chunk);
        yield chunk;
      }
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      try {
        const response =
          kind === "chat"
            ? aggregateChatChunks(chunks)
            : responseFromStreamEvents(chunks);
        setResponseAttributes(span, kind, response, traceContent);
      } finally {
        span.end();
      }
    }
  }

  (stream as any)[Symbol.asyncIterator] = wrapper;
  return stream;
};
