import { toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../shared/utils";

export const STRUCTURED_OUTPUT_SCHEMA =
  "gen_ai.request.structured_output_schema";

/**
 * Base URL of the client behind a resource instance. openai >= 4 resources
 * hold the client in `_client`; the v3 `OpenAIApi` keeps `basePath` itself.
 */
export const getBaseUrl = (instance: any): string | undefined => {
  const baseUrl =
    instance?._client?.baseURL ??
    instance?.basePath ??
    instance?.configuration?.basePath;
  return typeof baseUrl === "string" ? baseUrl : undefined;
};

export const getVendorFromUrl = (baseUrl: string | undefined): string => {
  if (!baseUrl) return "openai";
  if (baseUrl.includes("openai.azure.com")) return "Azure";
  if (baseUrl.includes("amazonaws.com") || baseUrl.includes("bedrock")) {
    return "AWS";
  }
  if (baseUrl.includes("googleapis.com") || baseUrl.includes("vertex")) {
    return "Google";
  }
  if (baseUrl.includes("openrouter.ai")) return "OpenRouter";
  return "openai";
};

/**
 * Bedrock model ids carry a vendor (`anthropic.claude-...`) and optionally a
 * cross-region prefix (`us.anthropic.claude-...`); keep only the model.
 */
const crossRegionCheck = (model: string): string => {
  if (!model.includes(".")) return model;
  const parts = model.split(".");
  if (["us", "us-gov", "eu", "apac"].includes(parts[0])) {
    return parts.length > 2 ? parts.slice(2).join(".") : model;
  }
  return parts.slice(1).join(".");
};

/**
 * Client attributes shared by every span: the vendor (from the base URL) as
 * `gen_ai.system`, the base URL itself and, for Azure, the API version.
 */
export const setClientAttributes = (
  span: LaminarSpan,
  instance: any,
): string => {
  const baseUrl = getBaseUrl(instance);
  const vendor = getVendorFromUrl(baseUrl);
  safeSetAttribute(span, "gen_ai.system", vendor);
  safeSetAttribute(span, "gen_ai.request.base_url", baseUrl);
  const client = instance?._client;
  safeSetAttribute(
    span,
    "gen_ai.openai.api_version",
    client?.apiVersion ?? client?._options?.defaultQuery?.["api-version"],
  );
  return vendor;
};

const extractStructuredOutputSchema = (params: any): string | undefined => {
  // `zodResponseFormat()` also produces this shape.
  const responseFormat = params?.response_format;
  if (responseFormat?.type === "json_schema") {
    return toJson(responseFormat.json_schema?.schema);
  }
  return undefined;
};

/**
 * Request attributes common to chat and legacy completions.
 */
export const setRequestAttributes = (
  span: LaminarSpan,
  params: any,
  instance: any,
): void => {
  const vendor = setClientAttributes(span, instance);
  let model = params?.model;
  if (vendor === "AWS" && typeof model === "string") {
    model = crossRegionCheck(model);
  }
  safeSetAttribute(span, "gen_ai.request.model", model);
  safeSetAttribute(span, "gen_ai.request.max_tokens", params?.max_tokens);
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
  safeSetAttribute(span, "llm.user", params?.user);
  span.setAttribute("llm.is_streaming", Boolean(params?.stream));
  safeSetAttribute(
    span,
    "gen_ai.request.reasoning_effort",
    params?.reasoning_effort,
  );
  safeSetAttribute(span, "openai.request.service_tier", params?.service_tier);
  safeSetAttribute(
    span,
    STRUCTURED_OUTPUT_SCHEMA,
    extractStructuredOutputSchema(params),
  );
};

export const setChatPromptAttributes = (
  span: LaminarSpan,
  params: any,
): void => {
  safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(params?.messages));
  safeSetAttribute(
    span,
    GEN_AI_TOOL_DEFINITIONS,
    toJson(params?.functions ?? params?.tools),
  );
};

export const setCompletionPromptAttributes = (
  span: LaminarSpan,
  params: any,
): void => {
  const prompt = params?.prompt;
  if (prompt !== undefined && prompt !== null) {
    const prompts = Array.isArray(prompt) ? prompt : [prompt];
    safeSetAttribute(
      span,
      GEN_AI_INPUT_MESSAGES,
      toJson(prompts.map((content) => ({ role: "user", content }))),
    );
  }
  safeSetAttribute(span, GEN_AI_TOOL_DEFINITIONS, toJson(params?.functions));
};

export const setEmbeddingsPromptAttributes = (
  span: LaminarSpan,
  params: any,
): void => {
  const input = params?.input;
  if (input === undefined || input === null) return;
  const inputs = Array.isArray(input) ? input : [input];
  safeSetAttribute(
    span,
    GEN_AI_INPUT_MESSAGES,
    toJson(inputs.map((content) => ({ content }))),
  );
};

/**
 * Response attributes for chat completions, legacy completions and
 * embeddings (and accumulated stream responses, which share the shape).
 */
export const setResponseAttributes = (span: LaminarSpan, response: any) => {
  if (!response || typeof response !== "object") return;
  if (response.error) {
    // Some OpenAI-compatible providers answer 200 with an error body.
    safeSetAttribute(
      span,
      "gen_ai.prompt.prompt_error",
      toJson(response.error),
    );
    return;
  }

  safeSetAttribute(span, "gen_ai.response.model", response.model);
  safeSetAttribute(span, "gen_ai.response.id", response.id);
  safeSetAttribute(
    span,
    "openai.response.system_fingerprint",
    response.system_fingerprint,
  );
  safeSetAttribute(
    span,
    "gen_ai.prompt.prompt_filter_results",
    toJson(response.prompt_filter_results),
  );
  safeSetAttribute(span, "openai.response.service_tier", response.service_tier);

  const usage = response.usage;
  if (!usage || typeof usage !== "object") return;
  span.setAttribute("llm.usage.total_tokens", usage.total_tokens ?? 0);
  span.setAttribute("gen_ai.usage.output_tokens", usage.completion_tokens ?? 0);
  span.setAttribute("gen_ai.usage.input_tokens", usage.prompt_tokens ?? 0);
  span.setAttribute(
    "gen_ai.usage.cache_read_input_tokens",
    usage.prompt_tokens_details?.cached_tokens ?? 0,
  );
  if (usage.completion_tokens_details) {
    span.setAttribute(
      "gen_ai.usage.reasoning_tokens",
      usage.completion_tokens_details.reasoning_tokens ?? 0,
    );
  }
};

export const setChoicesAttributes = (span: LaminarSpan, response: any) => {
  if (Array.isArray(response?.choices)) {
    safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson(response.choices));
  }
};

/**
 * Fold a chat completion chunk into the accumulated `ChatCompletion`.
 */
export const accumulateChatChunk = (
  complete: Record<string, any>,
  chunk: any,
): void => {
  if (!chunk || typeof chunk !== "object") return;
  complete.id ??= chunk.id;
  complete.model ??= chunk.model;
  complete.created ??= chunk.created;
  complete.service_tier = chunk.service_tier ?? complete.service_tier;
  complete.system_fingerprint =
    chunk.system_fingerprint ?? complete.system_fingerprint;
  if (chunk.prompt_filter_results) {
    complete.prompt_filter_results = chunk.prompt_filter_results;
  }
  // Some providers report usage on the first choice instead of the chunk.
  const usage = chunk.usage ?? chunk.choices?.[0]?.usage;
  if (usage) {
    complete.usage = usage;
  }

  for (const choice of chunk.choices ?? []) {
    const index = choice.index ?? 0;
    complete.choices[index] ??= {
      index,
      message: { role: "", content: "" },
    };
    const target = complete.choices[index];
    if (choice.finish_reason) {
      target.finish_reason = choice.finish_reason;
    }
    if (choice.content_filter_results) {
      target.content_filter_results = choice.content_filter_results;
    }

    const delta = choice.delta ?? {};
    if (delta.role) {
      target.message.role = delta.role;
    }
    if (delta.content) {
      target.message.content += delta.content;
    }
    if (delta.refusal) {
      target.message.refusal = (target.message.refusal ?? "") + delta.refusal;
    }
    if (delta.function_call) {
      target.message.function_call ??= { name: "", arguments: "" };
      target.message.function_call.name += delta.function_call.name ?? "";
      target.message.function_call.arguments +=
        delta.function_call.arguments ?? "";
    }
    for (const toolCall of delta.tool_calls ?? []) {
      target.message.tool_calls ??= [];
      const toolIndex = toolCall.index ?? 0;
      target.message.tool_calls[toolIndex] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      const call = target.message.tool_calls[toolIndex];
      if (toolCall.id) {
        call.id = toolCall.id;
      }
      if (toolCall.function?.name) {
        call.function.name = toolCall.function.name;
      }
      call.function.arguments += toolCall.function?.arguments ?? "";
    }
  }
};

/**
 * Fold a legacy completion chunk into the accumulated `Completion`.
 */
export const accumulateCompletionChunk = (
  complete: Record<string, any>,
  chunk: any,
): void => {
  if (!chunk || typeof chunk !== "object") return;
  complete.id ??= chunk.id;
  complete.model ??= chunk.model;
  complete.created ??= chunk.created;
  if (chunk.usage) {
    complete.usage = chunk.usage;
  }
  for (const choice of chunk.choices ?? []) {
    const index = choice.index ?? 0;
    complete.choices[index] ??= { index, text: "" };
    const target = complete.choices[index];
    target.text += choice.text ?? "";
    if (choice.finish_reason) {
      target.finish_reason = choice.finish_reason;
    }
  }
};

/**
 * `decisions.create` request attributes.
 */
export const setDecisionRequestAttributes = (
  span: LaminarSpan,
  params: any,
  instance: any,
  traceContent: boolean,
): void => {
  setClientAttributes(span, instance);
  safeSetAttribute(span, "gen_ai.request.model", params?.model);
  safeSetAttribute(span, "llm.user", params?.safety_identifier);
  if (!traceContent) return;

  const input = params?.input;
  if (typeof input === "string") {
    safeSetAttribute(
      span,
      GEN_AI_INPUT_MESSAGES,
      toJson([{ role: "user", content: input }]),
    );
  } else if (Array.isArray(input)) {
    safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(input));
  }
  // Questions are the output schema, not part of the prompt: a synthetic
  // system message would count as a new system prompt on every edit.
  if (Array.isArray(params?.questions)) {
    safeSetAttribute(span, STRUCTURED_OUTPUT_SCHEMA, toJson(params.questions));
  }
};

export const setDecisionResponseAttributes = (
  span: LaminarSpan,
  response: any,
  traceContent: boolean,
): void => {
  if (!response || typeof response !== "object") return;
  safeSetAttribute(span, "gen_ai.response.model", response.model);
  const usage = response.usage;
  if (usage && typeof usage === "object") {
    safeSetAttribute(span, "gen_ai.usage.input_tokens", usage.input_tokens);
    safeSetAttribute(span, "gen_ai.usage.output_tokens", usage.output_tokens);
    safeSetAttribute(span, "llm.usage.total_tokens", usage.total_tokens);
    safeSetAttribute(
      span,
      "gen_ai.usage.cache_read_input_tokens",
      usage.input_tokens_details?.cached_tokens,
    );
    safeSetAttribute(
      span,
      "gen_ai.usage.cache_creation_input_tokens",
      usage.input_tokens_details?.cache_write_tokens,
    );
    safeSetAttribute(
      span,
      "gen_ai.usage.reasoning_tokens",
      usage.output_tokens_details?.reasoning_tokens,
    );
  }
  if (traceContent && Array.isArray(response.answers)) {
    safeSetAttribute(
      span,
      GEN_AI_OUTPUT_MESSAGES,
      toJson([{ role: "assistant", content: toJson(response.answers) }]),
    );
  }
};
