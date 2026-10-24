import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../google-genai/utils";

export const COHERE_SYSTEM = "cohere";

const INPUT_MESSAGES = "gen_ai.input.messages";
const OUTPUT_MESSAGES = "gen_ai.output.messages";

export type RequestType = "chat" | "completion" | "rerank" | "embedding";

type Part = Record<string, unknown>;
type Message = { role: string; parts: Part[]; finish_reason?: string };

const OPERATION_NAMES: Record<RequestType, string> = {
  chat: "chat",
  completion: "text_completion",
  rerank: "rerank",
  embedding: "embeddings",
};

// v1 `chatHistory` roles
const V1_ROLES: Record<string, string> = {
  USER: "user",
  CHATBOT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
};

const asList = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const asInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;

const maybeJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const textPart = (text: unknown): Part => ({
  type: "text",
  content: typeof text === "string" ? text : JSON.stringify(text),
});

const imagePart = (url: string): Part => {
  // data URIs are kept inline as a blob, never uploaded anywhere
  const comma = url.indexOf(",");
  if (url.startsWith("data:") && comma !== -1) {
    return {
      type: "blob",
      modality: "image",
      mime_type: url.slice("data:".length, comma).split(";")[0],
      content: url.slice(comma + 1),
    };
  }
  return { type: "uri", modality: "image", uri: url };
};

/**
 * Convert v2 message content (a string or a list of content items) into parts.
 */
const contentParts = (content: unknown): Part[] => {
  if (typeof content === "string") {
    return content ? [textPart(content)] : [];
  }
  const parts: Part[] = [];
  for (const item of asList(content)) {
    if (typeof item === "string") {
      if (item) parts.push(textPart(item));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const url = item.imageUrl?.url;
    if (item.type === "text") {
      parts.push(textPart(item.text ?? ""));
    } else if (item.type === "thinking") {
      parts.push({ type: "thinking", content: item.thinking ?? "" });
    } else if (item.type === "image_url" && typeof url === "string") {
      parts.push(imagePart(url));
    } else {
      // documents, citations, ...: keep the block whole rather than guessing
      parts.push(item);
    }
  }
  return parts;
};

/**
 * v2 tool message content: a string, or a list of text / document items.
 */
const toolResult = (content: unknown): unknown => {
  if (typeof content === "string") return content;
  const results = asList(content).map((item) => {
    if (item?.type === "text") return item.text;
    if (item?.type === "document") return item.document?.data;
    return item;
  });
  return results.length === 1 ? results[0] : results;
};

const v2ToolCallParts = (toolCalls: unknown): Part[] =>
  asList(toolCalls).map((toolCall) => {
    const part: Part = {
      type: "tool_call",
      id: toolCall?.id ?? "",
      name: toolCall?.function?.name ?? "",
    };
    const args = toolCall?.function?.arguments;
    if (args !== undefined && args !== null) {
      part.arguments = maybeJson(args);
    }
    return part;
  });

// v1 tool calls have no id
const v1ToolCallParts = (toolCalls: unknown): Part[] =>
  asList(toolCalls).map((toolCall) => ({
    type: "tool_call",
    name: toolCall?.name ?? "",
    arguments: toolCall?.parameters,
  }));

const v1ToolResultParts = (toolResults: unknown): Part[] =>
  asList(toolResults).map((toolResult) => ({
    type: "tool_call_response",
    name: toolResult?.call?.name ?? "",
    result: toolResult?.outputs,
  }));

const v1Message = (message: any): Message => {
  const role = String(message?.role ?? "USER");
  const parts: Part[] = [];
  if (message?.message) parts.push(textPart(message.message));
  parts.push(...v1ToolCallParts(message?.toolCalls));
  parts.push(...v1ToolResultParts(message?.toolResults));
  return { role: V1_ROLES[role.toUpperCase()] ?? role.toLowerCase(), parts };
};

const v2Message = (message: any): Message => {
  const role = message?.role ?? "user";
  if (role === "tool") {
    return {
      role: "tool",
      parts: [
        {
          type: "tool_call_response",
          id: message?.toolCallId ?? "",
          result: toolResult(message?.content),
        },
      ],
    };
  }
  const parts = contentParts(message?.content);
  if (message?.toolPlan) parts.push(textPart(message.toolPlan));
  parts.push(...v2ToolCallParts(message?.toolCalls));
  return { role, parts };
};

const v1ChatInput = (params: any): Message[] => {
  const messages: Message[] = [];
  if (params?.preamble) {
    messages.push({ role: "system", parts: [textPart(params.preamble)] });
  }
  messages.push(...asList(params?.chatHistory).map(v1Message));
  const toolResults = v1ToolResultParts(params?.toolResults);
  if (toolResults.length > 0) {
    messages.push({ role: "tool", parts: toolResults });
  }
  if (params?.message) {
    messages.push({ role: "user", parts: [textPart(params.message)] });
  }
  return messages;
};

const rerankInput = (params: any): Message[] => {
  // documents first, then the query, as OpenLLMetry did
  const messages: Message[] = asList(params?.documents).map((document) => {
    const text = typeof document === "string" ? document : document?.text;
    return { role: "system", parts: [textPart(text ?? document)] };
  });
  if (params?.query) {
    messages.push({ role: "user", parts: [textPart(params.query)] });
  }
  return messages;
};

const embedInput = (params: any): Message[] => {
  const parts: Part[] = [
    ...asList(params?.texts)
      .filter((text) => typeof text === "string")
      .map(textPart),
    ...asList(params?.images)
      .filter((image) => typeof image === "string")
      .map(imagePart),
  ];
  for (const input of asList(params?.inputs)) {
    parts.push(...contentParts(input?.content));
  }
  return parts.length > 0 ? [{ role: "user", parts }] : [];
};

const toolDefinitions = (tools: unknown): Record<string, unknown>[] =>
  asList(tools).map((tool) => {
    // v2: { type: "function", function: {...} }
    // v1: { name, description, parameterDefinitions }
    const fn = tool?.function ?? tool;
    const definition: Record<string, unknown> = { name: fn?.name };
    if (fn?.description) definition.description = fn.description;
    const parameters = fn?.parameters ?? fn?.parameterDefinitions;
    if (parameters) definition.parameters = parameters;
    return definition;
  });

export const setRequestAttributes = (
  span: LaminarSpan,
  params: any,
  requestType: RequestType,
  isV2: boolean,
  isStreaming: boolean,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.system", COHERE_SYSTEM);
  safeSetAttribute(span, "gen_ai.operation.name", OPERATION_NAMES[requestType]);
  safeSetAttribute(span, "gen_ai.request.model", params?.model);
  safeSetAttribute(span, "gen_ai.request.max_tokens", asInt(params?.maxTokens));
  safeSetAttribute(span, "gen_ai.request.temperature", params?.temperature);
  safeSetAttribute(span, "gen_ai.request.top_p", params?.p);
  safeSetAttribute(span, "gen_ai.request.top_k", params?.k);
  safeSetAttribute(
    span,
    "gen_ai.request.frequency_penalty",
    params?.frequencyPenalty,
  );
  safeSetAttribute(
    span,
    "gen_ai.request.presence_penalty",
    params?.presencePenalty,
  );
  safeSetAttribute(span, "gen_ai.request.seed", asInt(params?.seed));
  safeSetAttribute(
    span,
    "gen_ai.request.stop_sequences",
    asList(params?.stopSequences).filter((s) => typeof s === "string"),
  );
  span.setAttribute("llm.is_streaming", isStreaming);

  if (!traceContent) return;

  let messages: Message[];
  if (requestType === "chat") {
    messages = isV2
      ? asList(params?.messages).map(v2Message)
      : v1ChatInput(params);
    const tools = toolDefinitions(params?.tools);
    if (tools.length > 0) {
      span.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools));
    }
  } else if (requestType === "completion") {
    messages = params?.prompt
      ? [{ role: "user", parts: [textPart(params.prompt)] }]
      : [];
  } else if (requestType === "rerank") {
    messages = rerankInput(params);
  } else {
    messages = embedInput(params);
  }

  if (messages.length > 0) {
    span.setAttribute(INPUT_MESSAGES, JSON.stringify(messages));
  }
};

/**
 * `usage` (v2) / `meta` (v1): actual `tokens`, falling back to `billedUnits`.
 */
const setUsage = (span: LaminarSpan, usage: any): void => {
  const inputTokens =
    asInt(usage?.tokens?.inputTokens) ?? asInt(usage?.billedUnits?.inputTokens);
  const outputTokens =
    asInt(usage?.tokens?.outputTokens) ??
    asInt(usage?.billedUnits?.outputTokens);
  safeSetAttribute(span, "gen_ai.usage.input_tokens", inputTokens);
  safeSetAttribute(span, "gen_ai.usage.output_tokens", outputTokens);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    span.setAttribute(
      "llm.usage.total_tokens",
      (inputTokens ?? 0) + (outputTokens ?? 0),
    );
  }
  safeSetAttribute(
    span,
    "gen_ai.usage.cache_read_input_tokens",
    asInt(usage?.cachedTokens),
  );
};

const v1ChatOutput = (response: any): Message => {
  const parts: Part[] = [];
  if (response?.text) parts.push(textPart(response.text));
  parts.push(...v1ToolCallParts(response?.toolCalls));
  return { role: "assistant", parts };
};

const v2ChatOutput = (response: any): Message => ({
  ...v2Message(response?.message ?? {}),
  role: "assistant",
});

const completionOutput = (response: any): Message[] =>
  asList(response?.generations).map((generation) => ({
    role: "assistant",
    parts: [textPart(generation?.text ?? "")],
  }));

const rerankOutput = (response: any): Message[] => {
  const parts = asList(response?.results).map((result) => {
    let text = `Doc ${result?.index}, Score: ${result?.relevanceScore}`;
    if (result?.document?.text) text += `\n${result.document.text}`;
    return textPart(text);
  });
  return parts.length > 0 ? [{ role: "assistant", parts }] : [];
};

export const setResponseAttributes = (
  span: LaminarSpan,
  response: any,
  requestType: RequestType,
  isV2: boolean,
  traceContent: boolean,
): void => {
  // v1 chat returns both `generationId` and `responseId`; the rest carry `id`
  safeSetAttribute(
    span,
    "gen_ai.response.id",
    response?.responseId ?? response?.id,
  );
  setUsage(span, response?.usage ?? response?.meta);

  let output: Message[] = [];
  if (requestType === "chat") {
    const message = isV2 ? v2ChatOutput(response) : v1ChatOutput(response);
    if (response?.finishReason) {
      const finishReason = String(response.finishReason);
      message.finish_reason = finishReason;
      span.setAttribute("gen_ai.response.finish_reasons", [finishReason]);
    }
    output = [message];
  } else if (requestType === "completion") {
    output = completionOutput(response);
  } else if (requestType === "rerank") {
    output = rerankOutput(response);
  }
  // embeddings have no message output: the vectors are not worth the payload

  if (output.length > 0 && traceContent) {
    span.setAttribute(OUTPUT_MESSAGES, JSON.stringify(output));
  }
};

export interface ChatStreamAccumulator {
  add(event: any): void;
  /** A `NonStreamedChatResponse` / `V2ChatResponse`-shaped object. */
  response(): any;
}

/**
 * v1 `chatStream`: the `stream-end` event carries the full response.
 */
export const createV1ChatStreamAccumulator = (): ChatStreamAccumulator => {
  let final: any;
  let text = "";
  const toolCalls: any[] = [];
  return {
    add: (event) => {
      if (event?.eventType === "text-generation") {
        text += event.text ?? "";
      } else if (event?.eventType === "tool-calls-generation") {
        toolCalls.push(...asList(event.toolCalls));
      } else if (event?.eventType === "stream-end") {
        final = event.response;
      }
    },
    // a stream abandoned before `stream-end` still records what it received
    response: () => final ?? { text, toolCalls },
  };
};

type V2Content = { type: string; text: string; thinking: string };
type V2ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * v2 `chatStream`: rebuilds a `V2ChatResponse`-shaped object from the events.
 */
export const createV2ChatStreamAccumulator = (): ChatStreamAccumulator => {
  let id: string | undefined;
  let toolPlan = "";
  let finishReason: string | undefined;
  let usage: any;
  const content = new Map<number, V2Content>();
  const toolCalls = new Map<number, V2ToolCall>();

  const indexOf = (event: any, items: Map<number, unknown>, isNew: boolean) => {
    if (typeof event?.index === "number") return event.index;
    if (isNew || items.size === 0) return items.size;
    return Math.max(...items.keys());
  };
  const sorted = <T>(items: Map<number, T>): T[] =>
    [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);

  return {
    add: (event) => {
      const message = event?.delta?.message;
      switch (event?.type) {
        case "message-start":
          id = event.id ?? id;
          break;
        case "content-start":
          content.set(indexOf(event, content, true), {
            type: message?.content?.type ?? "text",
            text: message?.content?.text ?? "",
            thinking: message?.content?.thinking ?? "",
          });
          break;
        case "content-delta": {
          const index = indexOf(event, content, false);
          const item = content.get(index) ?? {
            type: "text",
            text: "",
            thinking: "",
          };
          item.text += message?.content?.text ?? "";
          item.thinking += message?.content?.thinking ?? "";
          content.set(index, item);
          break;
        }
        case "tool-plan-delta":
          toolPlan += message?.toolPlan ?? "";
          break;
        case "tool-call-start":
          toolCalls.set(indexOf(event, toolCalls, true), {
            id: message?.toolCalls?.id ?? "",
            type: "function",
            function: {
              name: message?.toolCalls?.function?.name ?? "",
              arguments: message?.toolCalls?.function?.arguments ?? "",
            },
          });
          break;
        case "tool-call-delta": {
          const index = indexOf(event, toolCalls, false);
          const toolCall = toolCalls.get(index) ?? {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          toolCall.function.arguments +=
            message?.toolCalls?.function?.arguments ?? "";
          toolCalls.set(index, toolCall);
          break;
        }
        case "message-end":
          id = event.id ?? id;
          finishReason = event.delta?.finishReason;
          usage = event.delta?.usage;
          break;
      }
    },
    response: () => ({
      id,
      finishReason,
      usage,
      message: {
        role: "assistant",
        content: sorted(content).map((item) =>
          item.type === "thinking"
            ? { type: "thinking", thinking: item.thinking }
            : { type: "text", text: item.text },
        ),
        toolPlan: toolPlan || undefined,
        toolCalls: sorted(toolCalls),
      },
    }),
  };
};
