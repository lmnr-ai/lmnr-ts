import { type Attributes } from "@opentelemetry/api";

import { SPAN_TYPE } from "./attributes";

// AI SDK < v7 wraps every `.doGenerate` / `.doStream` LLM span in one of these
// operation spans, which repeats the LLM span's prompt and response.
const AI_SDK_WRAPPER_OPERATIONS = [
  "ai.generateText",
  "ai.streamText",
  "ai.generateObject",
  "ai.streamObject",
];

const AI_SDK_WRAPPER_RESPONSE_KEYS = [
  "ai.response.text",
  "ai.response.reasoning",
  "ai.response.toolCalls",
  "ai.response.object",
];

/**
 * Drop the duplicated prompt and response from an AI SDK v5/v6 wrapper span,
 * in place. The `.doGenerate` / `.doStream` LLM span is left untouched.
 */
export const dropAiSdkWrapperContent = (attributes: Attributes): void => {
  const operationId = attributes["ai.operationId"];
  if (
    typeof operationId !== "string" ||
    !AI_SDK_WRAPPER_OPERATIONS.includes(operationId) ||
    attributes[SPAN_TYPE] === "LLM"
  ) {
    return;
  }
  for (const key of AI_SDK_WRAPPER_RESPONSE_KEYS) {
    delete attributes[key];
  }
  // Older app-servers rename the span to its `functionId` only while `ai.prompt`
  // is set; a non-JSON placeholder keeps that without parsing it into an input.
  if (attributes["ai.prompt"] !== undefined) {
    attributes["ai.prompt"] = "_";
  }
};
