import { SpanStatusCode } from "@opentelemetry/api";

import { LaminarSpan } from "../../tracing/span";

export type SendKind = "chat" | "responses";

const TERMINAL_RESPONSE_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

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

export const setRequestAttributes = (
  span: LaminarSpan,
  kind: SendKind,
  request: any,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.request.model", request?.model);
  safeSetAttribute(span, "gen_ai.request.temperature", request?.temperature);
  safeSetAttribute(span, "gen_ai.request.top_p", request?.topP);
  safeSetAttribute(
    span,
    "gen_ai.request.max_tokens",
    kind === "chat" ? request?.maxTokens : request?.maxOutputTokens,
  );
  if (request?.stream) {
    safeSetAttribute(span, "llm.is_streaming", true);
  }
  if (Array.isArray(request?.tools) && request.tools.length > 0) {
    safeSetAttribute(
      span,
      "gen_ai.tool.definitions",
      JSON.stringify(request.tools),
    );
  }

  if (!traceContent) return;
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

export const setResponseAttributes = (
  span: LaminarSpan,
  kind: SendKind,
  response: any,
  traceContent: boolean,
): void => {
  if (!response) return;
  safeSetAttribute(span, "gen_ai.response.id", response.id);
  safeSetAttribute(span, "gen_ai.response.model", response.model);

  if (kind === "chat") {
    setUsageAttributes(
      span,
      response.usage,
      "promptTokens",
      "completionTokens",
      "upstreamInferencePromptCost",
      "upstreamInferenceCompletionsCost",
    );
  } else {
    setUsageAttributes(
      span,
      response.usage,
      "inputTokens",
      "outputTokens",
      "upstreamInferenceInputCost",
      "upstreamInferenceOutputCost",
    );
  }

  if (!traceContent) return;
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
  kind: SendKind,
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
