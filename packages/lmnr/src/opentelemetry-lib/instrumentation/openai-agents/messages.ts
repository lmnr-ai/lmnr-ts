import type { Span } from "@opentelemetry/api";

import { initializeLogger } from "../../../utils";
import { LaminarAttributes, SPAN_INPUT, SPAN_OUTPUT } from "../../tracing/attributes";
import {
  getFirstNotNull,
  modelAsDict,
  normalizeMessages,
} from "./helpers";

const logger = initializeLogger();

// ---------------------------------------------------------------------------
// gen_ai.input.messages / gen_ai.output.messages helpers
// ---------------------------------------------------------------------------

export const setLmnrSpanIo = (
  lmnrSpan: Span,
  inputData: any,
  outputData: any,
): void => {
  if (inputData !== undefined && inputData !== null) {
    lmnrSpan.setAttribute(SPAN_INPUT, JSON.stringify(inputData));
  }
  if (outputData !== undefined && outputData !== null) {
    lmnrSpan.setAttribute(SPAN_OUTPUT, JSON.stringify(outputData));
  }
};

export const setGenAiInputMessages = (
  lmnrSpan: Span,
  inputData: any,
  systemInstructions?: string | null,
): void => {
  const hasInput = inputData !== undefined && inputData !== null;
  if (!hasInput && !systemInstructions) {
    return;
  }
  const messages: Record<string, any>[] = hasInput ? normalizeMessages(inputData) : [];
  if (systemInstructions) {
    messages.unshift({
      role: "system",
      content: [{ type: "input_text", text: systemInstructions }],
    });
  }
  if (messages.length > 0) {
    lmnrSpan.setAttribute("gen_ai.input.messages", JSON.stringify(messages));
  }
};

export const setGenAiOutputMessages = (lmnrSpan: Span, outputData: any): void => {
  if (outputData === undefined || outputData === null) {
    return;
  }
  const messages = normalizeMessages(outputData, "assistant");
  if (messages.length > 0) {
    lmnrSpan.setAttribute("gen_ai.output.messages", JSON.stringify(messages));
  }
};

export const setGenAiOutputMessagesFromResponse = (
  lmnrSpan: Span,
  response: any,
): void => {
  if (response == null) {
    return;
  }

  let outputItems = response.output;
  if (!outputItems) {
    return;
  }

  const id = response.id;

  if (!Array.isArray(outputItems)) {
    logger.debug(
      "Laminar OpenAI agents instrumentation, failed to parse output items. Expected array",
    );
    outputItems = [];
  }

  const result = {
    id,
    object: "response",
    output: outputItems,
  };

  lmnrSpan.setAttribute("gen_ai.output.messages", JSON.stringify(result));
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const setToolDefinitionsFromResponse = (lmnrSpan: Span, response: any): void => {
  const tools = response?.tools;
  if (!tools || !Array.isArray(tools)) {
    return;
  }

  const toolDefs: Record<string, any>[] = [];
  for (const tool of tools) {
    const toolDict = modelAsDict(tool);
    if (!toolDict) {
      continue;
    }
    const toolType = toolDict.type;
    if (toolType === "function") {
      const funcDef: Record<string, any> = { type: "function" };
      const functionInfo = toolDict.function ?? toolDict;
      const fn: Record<string, any> = {
        name: functionInfo.name ?? "",
      };
      const desc = functionInfo.description;
      if (desc) {
        fn.description = desc;
      }
      const params = functionInfo.parameters;
      if (params) {
        fn.parameters = params;
      }
      const strict = functionInfo.strict;
      if (strict !== undefined && strict !== null) {
        fn.strict = strict;
      }
      funcDef.function = fn;
      toolDefs.push(funcDef);
    } else {
      toolDefs.push(toolDict);
    }
  }

  if (toolDefs.length > 0) {
    lmnrSpan.setAttribute("gen_ai.tool.definitions", JSON.stringify(toolDefs));
  }
};

// ---------------------------------------------------------------------------
// LLM attributes (model, usage, response_id)
// ---------------------------------------------------------------------------

export const applyLlmAttributes = (lmnrSpan: Span, data: Record<string, any>): void => {
  if (!data) {
    return;
  }

  const model = data.model;
  if (model) {
    lmnrSpan.setAttribute(LaminarAttributes.REQUEST_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.RESPONSE_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.PROVIDER, "openai");
  }

  const usage = data.usage;
  if (usage != null) {
    applyUsage(lmnrSpan, usage);
  }

  let responseId = data.response_id;
  if (responseId == null) {
    responseId = data.id;
  }
  if (responseId != null) {
    lmnrSpan.setAttribute("gen_ai.response.id", responseId);
  }
};

const applyUsage = (lmnrSpan: Span, usage: any): void => {
  if (usage == null) {
    return;
  }

  const inputTokens = getFirstNotNull(usage, "input_tokens", "prompt_tokens", "input");
  const outputTokens = getFirstNotNull(
    usage,
    "output_tokens",
    "completion_tokens",
    "output",
  );
  const totalTokens = getFirstNotNull(usage, "total_tokens", "total");
  const inputTokensDetails = getFirstNotNull(
    usage,
    "input_tokens_details",
    "prompt_tokens_details",
  );
  const outputTokensDetails = getFirstNotNull(
    usage,
    "output_tokens_details",
    "completion_tokens_details",
  );

  let cachedInputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;

  if (inputTokensDetails?.cached_tokens !== undefined && inputTokensDetails?.cached_tokens !== null) {
    cachedInputTokens = Number(inputTokensDetails.cached_tokens);
  }
  if (outputTokensDetails?.reasoning_tokens !== undefined &&
    outputTokensDetails?.reasoning_tokens !== null) {
    reasoningOutputTokens = Number(outputTokensDetails.reasoning_tokens);
  }
  if (inputTokens !== undefined && inputTokens !== null) {
    lmnrSpan.setAttribute(LaminarAttributes.INPUT_TOKEN_COUNT, Number(inputTokens));
  }
  if (cachedInputTokens !== undefined) {
    lmnrSpan.setAttribute("gen_ai.usage.cache_read_input_tokens", cachedInputTokens);
  }
  if (outputTokens !== undefined && outputTokens !== null) {
    lmnrSpan.setAttribute(LaminarAttributes.OUTPUT_TOKEN_COUNT, Number(outputTokens));
  }
  if (reasoningOutputTokens !== undefined) {
    lmnrSpan.setAttribute("gen_ai.usage.reasoning_output_tokens", reasoningOutputTokens);
  }
  if (totalTokens !== undefined && totalTokens !== null) {
    lmnrSpan.setAttribute(LaminarAttributes.TOTAL_TOKEN_COUNT, Number(totalTokens));
  } else if (
    inputTokens !== undefined && inputTokens !== null &&
    outputTokens !== undefined && outputTokens !== null
  ) {
    lmnrSpan.setAttribute(
      LaminarAttributes.TOTAL_TOKEN_COUNT,
      Number(inputTokens) + Number(outputTokens),
    );
  }
};

export const responseToLlmData = (response: any): Record<string, any> => {
  if (response == null) {
    return {};
  }
  return {
    model: response.model,
    usage: response.usage,
    response_id: response.id,
  };
};
