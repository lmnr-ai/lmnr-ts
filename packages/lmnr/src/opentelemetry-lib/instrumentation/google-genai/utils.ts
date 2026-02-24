import { SpanAttributes } from "@traceloop/ai-semantic-conventions";

import { LaminarSpan } from "../../tracing/span";

// Re-export attribute keys we use frequently
const LLM_REQUEST_MODEL = SpanAttributes.LLM_REQUEST_MODEL;
const LLM_RESPONSE_MODEL = SpanAttributes.LLM_RESPONSE_MODEL;
const LLM_SYSTEM = SpanAttributes.LLM_SYSTEM;
const LLM_REQUEST_TYPE = SpanAttributes.LLM_REQUEST_TYPE;
const LLM_USAGE_TOTAL_TOKENS = SpanAttributes.LLM_USAGE_TOTAL_TOKENS;

/**
 * Set an attribute on a span only if the value is non-null, non-undefined, and non-empty.
 */
function safeSetAttribute(
  span: LaminarSpan,
  key: string,
  value: unknown,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && value.length === 0) return;
  if (Array.isArray(value) && value.length === 0) return;
  span.setAttribute(key, value as any);
}

/**
 * Convert an SDK object to a plain JSON-serializable object.
 */
function toDict(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toDict);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) {
      result[k] = toDict(v);
    }
  }
  return result;
}

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
    } else if (typeof systemInstruction === "object" && systemInstruction !== null) {
      messages.push({ role: "system", ...toDict(systemInstruction) });
    }
  }

  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else {
        messages.push(toDict(item));
      }
    }
  } else if (contents && typeof contents === "object") {
    messages.push(toDict(contents));
  }

  return messages;
}

/**
 * Extract function declarations from the tools config.
 */
function extractToolDefinitions(config: any): any[] {
  if (!config?.tools) return [];
  const tools: any[] = [];
  const toolsArray = Array.isArray(config.tools) ? config.tools : [config.tools];

  for (const tool of toolsArray) {
    if (!tool) continue;
    // Tool can be a Tool object with functionDeclarations
    if (tool.functionDeclarations) {
      for (const fd of tool.functionDeclarations) {
        tools.push(toDict(fd));
      }
    }
    // Or it could be a single FunctionDeclaration-like object
    if (tool.name && !tool.functionDeclarations) {
      tools.push(toDict(tool));
    }
  }
  return tools;
}

/**
 * Set request attributes on a span from generateContent params.
 */
export function setRequestAttributes(
  span: LaminarSpan,
  params: any,
  traceContent: boolean,
): void {
  safeSetAttribute(span, LLM_SYSTEM, "gemini");
  safeSetAttribute(span, LLM_REQUEST_TYPE, "completion");

  safeSetAttribute(span, LLM_REQUEST_MODEL, params?.model);

  const config = params?.config;
  if (config) {
    safeSetAttribute(span, "gen_ai.request.temperature", config.temperature);
    safeSetAttribute(span, "gen_ai.request.top_p", config.topP);
    safeSetAttribute(span, "gen_ai.request.top_k", config.topK);
    safeSetAttribute(span, "gen_ai.request.max_tokens", config.maxOutputTokens);
    safeSetAttribute(span, "gen_ai.request.frequency_penalty", config.frequencyPenalty);
    safeSetAttribute(span, "gen_ai.request.presence_penalty", config.presencePenalty);
    safeSetAttribute(span, "gen_ai.request.seed", config.seed);
    safeSetAttribute(span, "gen_ai.request.choice_count", config.candidateCount);

    if (config.stopSequences && config.stopSequences.length > 0) {
      safeSetAttribute(span, "gen_ai.request.stop_sequences", JSON.stringify(config.stopSequences));
    }

    if (config.responseSchema) {
      safeSetAttribute(
        span,
        "gen_ai.request.structured_output_schema",
        JSON.stringify(toDict(config.responseSchema)),
      );
    }

    // Tool definitions
    const toolDefs = extractToolDefinitions(config);
    if (toolDefs.length > 0) {
      safeSetAttribute(span, "gen_ai.tool.definitions", JSON.stringify(toolDefs));
      for (let i = 0; i < toolDefs.length; i++) {
        const td = toolDefs[i];
        safeSetAttribute(span, `llm.request.functions.${i}.name`, td.name);
        safeSetAttribute(span, `llm.request.functions.${i}.description`, td.description);
        if (td.parameters) {
          safeSetAttribute(
            span,
            `llm.request.functions.${i}.parameters`,
            JSON.stringify(td.parameters),
          );
        }
      }
    }
  }

  // Input messages (content-traced only)
  if (traceContent) {
    const messages = contentToMessages(params?.contents, config?.systemInstruction);
    if (messages.length > 0) {
      safeSetAttribute(span, "gen_ai.input.messages", JSON.stringify(messages));
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
    safeSetAttribute(span, "gen_ai.usage.reasoning_tokens", usage.thoughtsTokenCount);
    safeSetAttribute(span, "llm.usage.cache_read_input_tokens", usage.cachedContentTokenCount);
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
            arguments: JSON.stringify(toDict(part.functionCall.args)),
          });
        }
      }

      const completionContent = textParts.join("");
      safeSetAttribute(span, `gen_ai.completion.${i}.role`, role);
      safeSetAttribute(span, `gen_ai.completion.${i}.content`, completionContent);

      for (let j = 0; j < toolCalls.length; j++) {
        const tc = toolCalls[j];
        safeSetAttribute(span, `gen_ai.completion.${i}.tool_calls.${j}.name`, tc.name);
        if (tc.id) {
          safeSetAttribute(span, `gen_ai.completion.${i}.tool_calls.${j}.id`, tc.id);
        }
        safeSetAttribute(
          span,
          `gen_ai.completion.${i}.tool_calls.${j}.arguments`,
          tc.arguments,
        );
      }

      outputMessages.push({
        role,
        content: completionContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }

    if (outputMessages.length > 0) {
      safeSetAttribute(span, "gen_ai.output.messages", JSON.stringify(outputMessages));
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
 * Wrap a streaming async generator to accumulate response data and set span attributes
 * once the stream is exhausted.
 *
 * generateContentStream returns Promise<AsyncGenerator<GenerateContentResponse>>.
 * This wraps the inner async generator.
 */
export function wrapStreamingResponse(
  span: LaminarSpan,
  asyncGen: AsyncGenerator<any>,
  traceContent: boolean,
): AsyncGenerator<any> {
  const accumulatedParts: any[] = [];
  let promptTokenCount: number | undefined;
  let candidatesTokenCount = 0;
  let thoughtsTokenCount = 0;
  let totalTokenCount = 0;
  let cachedContentTokenCount: number | undefined;
  let role: string | undefined;
  let modelVersion: string | undefined;

  async function* wrapper(): AsyncGenerator<any> {
    try {
      for await (const chunk of asyncGen) {
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
          if (promptTokenCount === undefined && usage.promptTokenCount !== undefined) {
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
          if (cachedContentTokenCount === undefined
            && usage.cachedContentTokenCount !== undefined) {
            cachedContentTokenCount = usage.cachedContentTokenCount;
          }
        }

        if (chunk?.modelVersion && !modelVersion) {
          modelVersion = chunk.modelVersion;
        }

        yield chunk;
      }

      // Stream exhausted — build compound response and set attributes
      const mergedParts = mergeTextParts(accumulatedParts);
      const compoundResponse = {
        modelVersion,
        candidates: [
          {
            content: {
              role: role ?? "model",
              parts: mergedParts,
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
      span.end();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: 2 }); // StatusCode.ERROR
      span.end();
      throw error;
    }
  }

  return wrapper();
}
