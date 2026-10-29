import { toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import {
  recordSpanError,
  safely,
  safeSetAttribute,
  traceAsyncIterable,
} from "../shared/utils";

// Re-export attribute keys we use frequently
const LLM_REQUEST_MODEL = "gen_ai.request.model";
const LLM_RESPONSE_MODEL = "gen_ai.response.model";
const LLM_SYSTEM = "gen_ai.system";
const LLM_USAGE_TOTAL_TOKENS = "llm.usage.total_tokens";

/**
 * Normalize contents to an array of {role, parts} message objects.
 * The GenAI SDK accepts many content shapes; this normalizes them for attribute logging.
 */
function contentToMessages(
  contents: unknown,
  systemInstruction?: unknown,
): unknown[] {
  const messages: unknown[] = [];

  if (systemInstruction) {
    if (typeof systemInstruction === "string") {
      messages.push({ role: "system", content: systemInstruction });
    } else if (
      typeof systemInstruction === "object" &&
      systemInstruction !== null
    ) {
      messages.push({
        role: "system",
        ...(systemInstruction as Record<string, any>),
      });
    }
  }

  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else {
        messages.push(item);
      }
    }
  } else if (contents && typeof contents === "object") {
    messages.push(contents);
  }

  return messages;
}

/**
 * Extract function declarations from the tools config.
 */
function extractToolDefinitions(config: any): any[] {
  if (!config?.tools) return [];
  const tools: any[] = [];
  const toolsArray = Array.isArray(config.tools)
    ? config.tools
    : [config.tools];

  for (const tool of toolsArray) {
    if (!tool) continue;
    // Tool can be a Tool object with functionDeclarations
    if (tool.functionDeclarations) {
      for (const fd of tool.functionDeclarations) {
        tools.push(fd);
      }
    }
    // Or it could be a single FunctionDeclaration-like object
    if (tool.name && !tool.functionDeclarations) {
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * Set request attributes on a span from generateContent params.
 * Also used by the google-aiplatform (Vertex AI) instrumentation, which
 * reshapes its requests into the same `{model, contents, config}` form.
 */
export function setRequestAttributes(
  span: LaminarSpan,
  params: any,
  traceContent: boolean,
  system: string = "gemini",
): void {
  safeSetAttribute(span, LLM_SYSTEM, system);

  safeSetAttribute(span, LLM_REQUEST_MODEL, params?.model);

  const config = params?.config;
  if (config) {
    safeSetAttribute(span, "gen_ai.request.temperature", config.temperature);
    safeSetAttribute(span, "gen_ai.request.top_p", config.topP);
    safeSetAttribute(span, "gen_ai.request.top_k", config.topK);
    safeSetAttribute(span, "gen_ai.request.max_tokens", config.maxOutputTokens);
    safeSetAttribute(
      span,
      "gen_ai.request.frequency_penalty",
      config.frequencyPenalty,
    );
    safeSetAttribute(
      span,
      "gen_ai.request.presence_penalty",
      config.presencePenalty,
    );
    safeSetAttribute(span, "gen_ai.request.seed", config.seed);
    safeSetAttribute(
      span,
      "gen_ai.request.choice_count",
      config.candidateCount,
    );

    if (config.stopSequences && config.stopSequences.length > 0) {
      safeSetAttribute(
        span,
        "gen_ai.request.stop_sequences",
        toJson(config.stopSequences),
      );
    }

    const outputSchema = config.responseSchema ?? config.responseJsonSchema;
    if (outputSchema) {
      safeSetAttribute(
        span,
        "gen_ai.request.structured_output_schema",
        toJson(outputSchema),
      );
    }

    // Tool definitions
    const toolDefs = extractToolDefinitions(config);
    if (toolDefs.length > 0) {
      safeSetAttribute(span, GEN_AI_TOOL_DEFINITIONS, toJson(toolDefs));
    }
  }

  // Input messages (content-traced only)
  if (traceContent) {
    const messages = contentToMessages(
      params?.contents,
      config?.systemInstruction,
    );
    if (messages.length > 0) {
      safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(messages));
    }
  }
}

/**
 * Set response attributes on a span from a GenerateContentResponse.
 */
export function setResponseAttributes(
  span: LaminarSpan,
  response: any,
  traceContent: boolean,
): void {
  if (!response) return;

  safeSetAttribute(span, LLM_RESPONSE_MODEL, response.modelVersion);

  // Usage metadata
  const usage = response.usageMetadata;
  if (usage) {
    safeSetAttribute(span, "gen_ai.usage.input_tokens", usage.promptTokenCount);

    const outputTokens =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    if (outputTokens > 0) {
      safeSetAttribute(span, "gen_ai.usage.output_tokens", outputTokens);
    }

    safeSetAttribute(span, LLM_USAGE_TOTAL_TOKENS, usage.totalTokenCount);
    safeSetAttribute(
      span,
      "gen_ai.usage.reasoning_tokens",
      usage.thoughtsTokenCount,
    );
    safeSetAttribute(
      span,
      "gen_ai.usage.cache_read_input_tokens",
      usage.cachedContentTokenCount,
    );
  }

  // Response content (content-traced only)
  if (traceContent && response.candidates) {
    const outputMessages: any[] = [];

    for (let i = 0; i < response.candidates.length; i++) {
      const candidate = response.candidates[i];
      const content = candidate?.content;
      if (!content) continue;

      const role = content.role ?? "model";

      // Extract text content and tool calls
      const parts = content.parts ?? [];
      const textParts: string[] = [];
      const toolCalls: any[] = [];

      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part.text !== undefined) {
          textParts.push(part.text);
        }
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            id: part.functionCall.id,
            arguments: toJson(part.functionCall.args),
          });
        }
      }

      const completionContent = textParts.join("");

      outputMessages.push({
        role,
        content: completionContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }

    if (outputMessages.length > 0) {
      safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson(outputMessages));
    }
  }
}

/**
 * Merge consecutive text parts in accumulated streaming parts.
 */
function mergeTextParts(parts: any[]): any[] {
  if (parts.length === 0) return parts;

  const merged: any[] = [];
  for (const part of parts) {
    if (
      part.text !== undefined &&
      merged.length > 0 &&
      merged[merged.length - 1].text !== undefined
    ) {
      merged[merged.length - 1] = {
        ...merged[merged.length - 1],
        text: merged[merged.length - 1].text + part.text,
      };
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

/**
 * Wrap a streaming async generator to accumulate response data and set span
 * attributes when iteration completes, throws, or is terminated early by the
 * consumer.
 *
 * generateContentStream returns Promise<AsyncGenerator<GenerateContentResponse>>.
 * This wraps the inner async generator.
 */
export const wrapStreamingResponse = (
  span: LaminarSpan,
  asyncGen: AsyncGenerator<any>,
  traceContent: boolean,
): AsyncGenerator<any> => {
  const accumulatedParts: any[] = [];
  let promptTokenCount: number | undefined;
  let candidatesTokenCount: number | undefined;
  let thoughtsTokenCount: number | undefined;
  let totalTokenCount: number | undefined;
  let cachedContentTokenCount: number | undefined;
  let role: string | undefined;
  let modelVersion: string | undefined;
  let sawUsageMetadata = false;

  const onEvent = (chunk: any) => {
    // Accumulate parts
    if (chunk?.candidates) {
      for (const candidate of chunk.candidates) {
        const parts = candidate?.content?.parts;
        if (parts) {
          accumulatedParts.push(...parts);
        }
        if (candidate?.content?.role && !role) {
          role = candidate.content.role;
        }
      }
    }

    // Accumulate usage
    const usage = chunk?.usageMetadata;
    if (usage) {
      sawUsageMetadata = true;
      if (
        promptTokenCount === undefined &&
        usage.promptTokenCount !== undefined
      ) {
        promptTokenCount = usage.promptTokenCount;
      }
      if (usage.candidatesTokenCount !== undefined) {
        candidatesTokenCount = usage.candidatesTokenCount;
      }
      if (usage.thoughtsTokenCount !== undefined) {
        thoughtsTokenCount = usage.thoughtsTokenCount;
      }
      if (usage.totalTokenCount !== undefined) {
        totalTokenCount = usage.totalTokenCount;
      }
      if (
        cachedContentTokenCount === undefined &&
        usage.cachedContentTokenCount !== undefined
      ) {
        cachedContentTokenCount = usage.cachedContentTokenCount;
      }
    }

    if (chunk?.modelVersion && !modelVersion) {
      modelVersion = chunk.modelVersion;
    }
  };

  const setAccumulatedResponse = () => {
    const hasResponseData =
      modelVersion !== undefined ||
      role !== undefined ||
      accumulatedParts.length > 0 ||
      sawUsageMetadata;
    if (!hasResponseData) return;
    const compoundResponse = {
      modelVersion,
      candidates: [
        {
          content: {
            role: role ?? "model",
            parts: mergeTextParts(accumulatedParts),
          },
        },
      ],
      usageMetadata: {
        promptTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount,
        totalTokenCount,
        cachedContentTokenCount,
      },
    };
    setResponseAttributes(span, compoundResponse, traceContent);
  };

  return traceAsyncIterable(asyncGen, {
    onEvent,
    onDone: (error) => {
      if (error !== undefined) recordSpanError(span, error);
      safely(setAccumulatedResponse);
      span.end();
    },
  });
};
