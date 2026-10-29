/**
 * Translate LangChain callback payloads into span attributes.
 *
 * LLM spans carry the OTel GenAI message shape (`{role, parts: [...]}` arrays
 * in `gen_ai.input.messages` / `gen_ai.output.messages`). Chain, tool and
 * retriever spans carry their raw inputs and outputs in `lmnr.span.input` /
 * `lmnr.span.output`.
 */

import { parseJson, toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../shared/utils";

const ROLE_BY_MESSAGE_TYPE: Record<string, string> = {
  human: "user",
  system: "system",
  ai: "assistant",
  tool: "tool",
  function: "tool",
};

const FINISH_REASON_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
  // Anthropic, surfaced through @langchain/anthropic
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_call",
  max_tokens: "length",
};

const MODEL_KEYS = ["model", "model_name", "model_id", "modelName"];

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, any> =>
  isRecord(value) ? value : {};

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

export const messageType = (message: any): string => {
  const type = message?.type ?? message?._getType?.() ?? message?.getType?.();
  return typeof type === "string" ? type : "";
};

export const messageRole = (type: string): string =>
  ROLE_BY_MESSAGE_TYPE[type] ?? (type || "unknown");

/**
 * Convert LangChain message content (string or list of blocks) into GenAI
 * parts.
 */
export const contentToParts = (content: unknown): Record<string, any>[] => {
  if (typeof content === "string") {
    return content ? [{ type: "text", content }] : [];
  }
  if (!Array.isArray(content)) {
    return content ? [{ type: "text", content: String(content) }] : [];
  }

  const parts: Record<string, any>[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push({ type: "text", content: block });
      continue;
    }
    if (!isRecord(block)) {
      parts.push({ type: "text", content: String(block) });
      continue;
    }
    if (block.type === "text") {
      if (block.text) parts.push({ type: "text", content: block.text });
    } else if (block.type === "image_url") {
      const url = isRecord(block.image_url)
        ? block.image_url.url
        : block.image_url;
      if (url) parts.push({ type: "uri", modality: "image", uri: url });
    } else if (block.type === "image" && block.url) {
      parts.push({ type: "uri", modality: "image", uri: block.url });
    } else if (block.type === "image") {
      parts.push({
        type: "blob",
        modality: "image",
        mime_type: block.mime_type || block.mimeType || block.media_type || "",
        content: block.data || block.base64 || "",
      });
    } else {
      // Provider-specific block (reasoning, tool_use, ...): keep it whole
      // rather than guessing at a mapping.
      parts.push(block);
    }
  }
  return parts;
};

export const toolCallsToParts = (toolCalls: unknown): Record<string, any>[] => {
  if (!Array.isArray(toolCalls)) return [];
  const parts: Record<string, any>[] = [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = asRecord(toolCall.function);
    const part: Record<string, any> = {
      type: "tool_call",
      id: toolCall.id || "",
      name: toolCall.name || fn.name || "",
    };
    const args = toolCall.args ?? fn.arguments;
    if (args !== undefined && args !== null) {
      part.arguments = parseJson(args);
    }
    parts.push(part);
  }
  return parts;
};

const messageToolCalls = (message: any): unknown => {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls;
  }
  return message?.additional_kwargs?.tool_calls;
};

export const messageToDict = (message: any): Record<string, any> => {
  const role = messageRole(messageType(message));
  const toolCallId = message?.tool_call_id;
  if (role === "tool" && toolCallId) {
    return {
      role,
      parts: [
        {
          type: "tool_call_response",
          id: toolCallId,
          response: message.content,
        },
      ],
    };
  }
  const parts = [
    ...contentToParts(message?.content),
    ...toolCallsToParts(messageToolCalls(message)),
  ];
  const functionCall = message?.additional_kwargs?.function_call;
  if (isRecord(functionCall)) {
    // Legacy OpenAI single function-call format
    parts.push({
      type: "tool_call",
      id: "",
      name: functionCall.name || "",
      arguments: parseJson(functionCall.arguments),
    });
  }
  return { role, parts };
};

const firstModel = (...sources: Record<string, any>[]): string | undefined => {
  for (const source of sources) {
    for (const key of MODEL_KEYS) {
      const model = source[key];
      if (typeof model === "string" && model) return model;
    }
  }
  return undefined;
};

/**
 * Record the request model and sampling params. Returns the request model.
 */
export const setRequestAttributes = (
  span: LaminarSpan,
  serialized: any,
  metadata: Record<string, any> | undefined,
  extraParams: Record<string, any> | undefined,
  traceContent: boolean,
): string | undefined => {
  const invocationParams = asRecord(extraParams?.invocation_params);
  // Some integrations nest the provider params one level deeper
  const nested = asRecord(invocationParams.params);
  const params = Object.keys(nested).length > 0 ? nested : invocationParams;
  const serializedKwargs = asRecord(serialized?.kwargs);

  let model = firstModel(params, invocationParams, serializedKwargs);
  if (model === undefined) {
    const lsModelName = metadata?.ls_model_name;
    model =
      typeof lsModelName === "string" && lsModelName ? lsModelName : undefined;
  }
  safeSetAttribute(span, "gen_ai.request.model", model);

  const param = (...keys: string[]): unknown => {
    for (const source of [params, serializedKwargs]) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) {
          return source[key];
        }
      }
    }
    return undefined;
  };

  const maxTokens = param(
    "max_tokens",
    "max_completion_tokens",
    "max_new_tokens",
    "maxTokens",
  );
  const temperature = param("temperature");
  const topP = param("top_p", "topP");
  if (isInt(maxTokens)) {
    span.setAttribute("gen_ai.request.max_tokens", maxTokens);
  }
  if (typeof temperature === "number") {
    span.setAttribute("gen_ai.request.temperature", temperature);
  }
  if (typeof topP === "number") {
    span.setAttribute("gen_ai.request.top_p", topP);
  }

  const tools = params.tools || params.functions;
  if (traceContent && Array.isArray(tools) && tools.length > 0) {
    const definitions = tools.map((tool: unknown) => {
      const record = asRecord(tool);
      const fn = isRecord(record.function) ? record.function : record;
      const definition: Record<string, any> = { name: fn.name };
      if (fn.description) definition.description = fn.description;
      const parameters = fn.parameters || record.input_schema;
      if (parameters) definition.parameters = parameters;
      return definition;
    });
    safeSetAttribute(span, GEN_AI_TOOL_DEFINITIONS, toJson(definitions));
  }

  return model;
};

export const setChatRequest = (
  span: LaminarSpan,
  messages: any[][],
  traceContent: boolean,
): void => {
  if (!traceContent) return;
  const inputMessages = (messages ?? []).flatMap((batch) =>
    (batch ?? []).map(messageToDict),
  );
  if (inputMessages.length > 0) {
    safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(inputMessages));
  }
};

export const setCompletionRequest = (
  span: LaminarSpan,
  prompts: string[],
  traceContent: boolean,
): void => {
  if (!traceContent) return;
  const inputMessages = (prompts ?? []).map((prompt) => ({
    role: "user",
    parts: [{ type: "text", content: prompt }],
  }));
  if (inputMessages.length > 0) {
    safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(inputMessages));
  }
};

const allGenerations = (response: any): any[] =>
  Array.isArray(response?.generations)
    ? response.generations.flatMap((batch: unknown) =>
        Array.isArray(batch) ? batch : [],
      )
    : [];

const setUsage = (span: LaminarSpan, response: any): void => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let found = false;

  for (const generation of allGenerations(response)) {
    const usage = asRecord(generation?.message?.usage_metadata);
    if (Object.keys(usage).length === 0) continue;
    found = true;
    // LangChain's `input_tokens` already includes cached tokens; the details
    // only break that total down.
    inputTokens += isInt(usage.input_tokens) ? usage.input_tokens : 0;
    outputTokens += isInt(usage.output_tokens) ? usage.output_tokens : 0;
    const details = asRecord(usage.input_token_details);
    if (isInt(details.cache_read)) {
      cacheReadTokens = (cacheReadTokens ?? 0) + details.cache_read;
    }
    if (isInt(details.cache_creation)) {
      cacheCreationTokens = (cacheCreationTokens ?? 0) + details.cache_creation;
    }
  }

  if (!found) {
    // Fall back to the provider-reported totals in `llmOutput`, which
    // completion (non-chat) models and older integrations still use.
    const llmOutput = asRecord(response?.llmOutput);
    const tokenUsage = asRecord(
      llmOutput.tokenUsage ?? llmOutput.token_usage ?? llmOutput.usage,
    );
    if (Object.keys(tokenUsage).length === 0) return;
    const pick = (...keys: string[]): number => {
      for (const key of keys) {
        if (isInt(tokenUsage[key]) && tokenUsage[key] !== 0) {
          return tokenUsage[key];
        }
      }
      return 0;
    };
    inputTokens = pick(
      "promptTokens",
      "prompt_tokens",
      "input_tokens",
      "input_token_count",
    );
    outputTokens = pick(
      "completionTokens",
      "completion_tokens",
      "output_tokens",
      "generated_token_count",
    );
  }

  span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
  span.setAttribute("llm.usage.total_tokens", inputTokens + outputTokens);
  safeSetAttribute(
    span,
    "gen_ai.usage.cache_read_input_tokens",
    cacheReadTokens,
  );
  safeSetAttribute(
    span,
    "gen_ai.usage.cache_creation_input_tokens",
    cacheCreationTokens,
  );
};

const responseModelAndId = (response: any): { model?: string; id?: string } => {
  const llmOutput = asRecord(response?.llmOutput);
  let model = firstModel(llmOutput);
  let id: unknown = llmOutput.id;
  for (const generation of allGenerations(response)) {
    const message = generation?.message;
    if (model === undefined) {
      model = firstModel(asRecord(message?.response_metadata));
    }
    if (id === undefined || id === null) {
      id = message?.id;
    }
  }
  return { model, id: typeof id === "string" && id ? id : undefined };
};

const finishReasonOf = (generation: any): string | undefined => {
  const info = asRecord(generation?.generationInfo);
  const metadata = asRecord(generation?.message?.response_metadata);
  const raw =
    info.finish_reason ||
    info.stop_reason ||
    metadata.finish_reason ||
    metadata.stop_reason;
  return typeof raw === "string" ? (FINISH_REASON_MAP[raw] ?? raw) : undefined;
};

export const setResponseAttributes = (
  span: LaminarSpan,
  response: any,
  requestModel: string | undefined,
  traceContent: boolean,
): void => {
  const { model, id } = responseModelAndId(response);
  safeSetAttribute(span, "gen_ai.response.model", model ?? requestModel);
  if (requestModel === undefined) {
    safeSetAttribute(span, "gen_ai.request.model", model);
  }
  safeSetAttribute(span, "gen_ai.response.id", id);
  setUsage(span, response);

  const outputMessages: Record<string, any>[] = [];
  const finishReasons: string[] = [];
  for (const generation of allGenerations(response)) {
    const finishReason = finishReasonOf(generation);
    if (finishReason && !finishReasons.includes(finishReason)) {
      finishReasons.push(finishReason);
    }
    if (!traceContent) continue;
    const message = generation?.message;
    const outputMessage =
      message && typeof message === "object"
        ? messageToDict(message)
        : { role: "assistant", parts: contentToParts(generation?.text) };
    outputMessage.finish_reason = finishReason ?? "";
    outputMessages.push(outputMessage);
  }

  if (finishReasons.length > 0) {
    span.setAttribute("gen_ai.response.finish_reasons", finishReasons);
  }
  if (outputMessages.length > 0) {
    safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson(outputMessages));
  }
};

/**
 * Return plain-data metadata as is, or undefined for anything else.
 *
 * Class instances are dropped rather than stringified: a model, client or
 * config object routinely carries credentials the caller never meant to
 * export.
 */
const metadataValue = (value: unknown): unknown => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(metadataValue).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const kept = Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, metadataValue(item)])
        .filter(([, item]) => item !== undefined),
    );
    return Object.keys(kept).length > 0 ? kept : undefined;
  }
  return undefined;
};

export const sanitizeMetadata = (
  metadata: Record<string, any> | undefined,
): Record<string, any> => {
  if (!isRecord(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .map(([key, value]) => [key, metadataValue(value)])
      .filter(([, value]) => value !== undefined),
  );
};

export const retrieverOutput = (documents: unknown): unknown[] => {
  if (!Array.isArray(documents)) return [];
  return documents.map((document) => {
    const pageContent = document?.pageContent ?? document?.page_content;
    if (pageContent === undefined || pageContent === null) return document;
    return { page_content: pageContent, metadata: document?.metadata ?? {} };
  });
};
