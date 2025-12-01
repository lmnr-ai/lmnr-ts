import { trace } from "@opentelemetry/api";
import { zodToJsonSchema } from "zod-to-json-schema";

import { observe as laminarObserve } from "../../decorators";
import { SPAN_TYPE } from "../../opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "../../opentelemetry-lib/tracing/context";
import { modelToProvider } from "../utils";

export interface GlobalLLMClientOptions {
  provider: "openai" | "anthropic" | "cerebras" | "groq" | (string & {})
  model: string
}

interface CreateChatCompletionOptions {
  options: {
    messages?: any[];
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    maxTokens?: number;
    maxOutputTokens?: number;
    response_model?: {
      name: string;
      schema: any;
    };
    tools?: any[];
  };
  logger?: (message: any) => void;
  retries?: number;
}

interface LLMResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: {
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }[];
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Creates a wrapper function for LLM client's createChatCompletion method
 * that adds OpenTelemetry tracing with detailed span attributes.
 *
 * This wrapper is shared between Stagehand v2 and v3 instrumentations.
 *
 * @param globalLLMClientOptions - WeakMap to track LLM client options (provider and model)
 * @returns A wrapper function compatible with OpenTelemetry's _wrap method
 */
export const createLLMClientCreateChatCompletionWrapper = (
  globalLLMClientOptions: WeakMap<any, GlobalLLMClientOptions | undefined>,
) => (original: (...args: any[]) => Promise<any>) =>
  async function createChatCompletion(this: any, ...args: any[]) {
    const options = args[0] as CreateChatCompletionOptions;
    return await laminarObserve({
      name: "createChatCompletion",
      // input and output are set as gen_ai.prompt and gen_ai.completion
      ignoreInput: true,
      ignoreOutput: true,
    }, async () => {
      const currentSpan = trace.getSpan(LaminarContextManager.getContext())
          ?? trace.getActiveSpan();
      const span = currentSpan!;
      const innerOptions = options.options;
      const recordedProvider = globalLLMClientOptions.get(this)?.provider;
      const provider = (
        recordedProvider === "aisdk"
          && globalLLMClientOptions.get(this)?.model
      )
        ? (
          modelToProvider(globalLLMClientOptions.get(this)!.model)
            ?? "aisdk"
        )
        : recordedProvider;

      // Set request attributes
      span.setAttributes({
        [SPAN_TYPE]: "LLM",
        ...(innerOptions.temperature ? {
          "gen_ai.request.temperature": innerOptions.temperature,
        } : {}),
        ...(innerOptions.top_p ? {
          "gen_ai.request.top_p": innerOptions.top_p,
        } : {}),
        ...(innerOptions.frequency_penalty ? {
          "gen_ai.request.frequency_penalty": innerOptions.frequency_penalty,
        } : {}),
        ...(innerOptions.presence_penalty ? {
          "gen_ai.request.presence_penalty": innerOptions.presence_penalty,
        } : {}),
        ...((innerOptions.maxTokens !== undefined || innerOptions.maxOutputTokens !== undefined) ? {
          "gen_ai.request.max_tokens": innerOptions.maxTokens ?? innerOptions.maxOutputTokens,
        } : {}),
        ...(globalLLMClientOptions.get(this) ? {
          "gen_ai.request.model": globalLLMClientOptions.get(this)?.model,
          "gen_ai.system": provider,
        } : {}),
      });

      // Set message attributes
      innerOptions.messages?.forEach((message, index) => {
        span.setAttributes({
          [`gen_ai.prompt.${index}.role`]: message.role,
          [`gen_ai.prompt.${index}.content`]: JSON.stringify(message.content),
        });
      });

      // Set tool/function attributes
      innerOptions.tools?.forEach((tool, index) => {
        span.setAttributes({
          [`llm.request.functions.${index}.name`]: tool.name,
          [`llm.request.functions.${index}.description`]: tool.description,
          [`llm.request.functions.${index}.parameters`]: JSON.stringify(tool.parameters),
        });
      });

      // Set structured output schema if present
      if (innerOptions.response_model?.schema) {
        const schema = zodToJsonSchema(innerOptions.response_model.schema);
        if (schema) {
          span.setAttributes({
            [`gen_ai.request.structured_output_schema`]: JSON.stringify(schema),
          });
        }
      }

      // Execute the original method
      const result = await original.bind(this).apply(this, args) as LLMResponse;

      // Set response attributes
      span.setAttributes({
        "gen_ai.response.model": result.model,
        "gen_ai.usage.input_tokens": result.usage?.prompt_tokens ?? 0,
        "gen_ai.usage.output_tokens": result.usage?.completion_tokens ?? 0,
        "llm.usage.total_tokens": result.usage?.total_tokens ?? 0,
      });

      // Set completion attributes
      result.choices?.forEach(choice => {
        const index = choice.index;
        span.setAttributes({
          [`gen_ai.completion.${index}.finish_reason`]: choice.finish_reason,
          [`gen_ai.completion.${index}.role`]: choice.message.role,
        });
        if (choice.message.content) {
          span.setAttribute(
            `gen_ai.completion.${index}.content`,
            JSON.stringify(choice.message.content),
          );
        }
        choice.message.tool_calls?.forEach((toolCall, toolCallIndex) => {
          span.setAttributes({
            [`gen_ai.completion.${index}.message.tool_calls.${toolCallIndex}.id`]: toolCall.id,
            [`gen_ai.completion.${index}.message.tool_calls.${toolCallIndex}.name`]:
                toolCall.function.name,
            [`gen_ai.completion.${index}.message.tool_calls.${toolCallIndex}.arguments`]:
                JSON.stringify(toolCall.function.arguments),
          });
        });
      });

      // Handle special case when choices is empty (structured output mode)
      if (!result.choices || result.choices.length === 0) {
        const data = (result as any).data;
        if (data) {
          span.setAttributes({
            "gen_ai.completion.0.role": "assistant",
            "gen_ai.completion.0.content": typeof data === "string"
              ? data
              : JSON.stringify(data),
          });
        }
      }

      return result;
    });
  };
