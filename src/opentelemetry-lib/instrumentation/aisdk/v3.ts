import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3ResponseMetadata,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
  type SharedV3Headers,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider";

import { BaseLaminarLanguageModel } from "./base-language-model";

export class LaminarLanguageModelV3 extends BaseLaminarLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';

  protected readonly innerLanguageModel: LanguageModelV3;

  constructor(languageModel: LanguageModelV3) {
    super(languageModel);
    this.innerLanguageModel = languageModel;
  }

  protected createUsageObject(): LanguageModelV3Usage {
    return {
      inputTokens: {
        total: 0,
        noCache: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 0,
        text: 0,
        reasoning: 0,
      },
    };
  }

  doGenerate(options: LanguageModelV3CallOptions): PromiseLike<{
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    providerMetadata?: SharedV3ProviderMetadata;
    request?: {
      body?: unknown;
    };
    response?: LanguageModelV3ResponseMetadata & {
      headers?: SharedV3Headers;
      body?: unknown;
    };
    warnings: Array<SharedV3Warning>;
  }> {
    return this.doGenerateWithCaching(
      options,
      (opts) => this.innerLanguageModel.doGenerate(opts)
    );
  }

  doStream(options: LanguageModelV3CallOptions): PromiseLike<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
    request?: {
      body?: unknown;
    };
    response?: {
      headers?: SharedV3Headers;
    };
  }> {
    return this.doStreamWithCaching(
      options,
      (opts) => this.innerLanguageModel.doStream(opts)
    );
  }

  protected createStreamFromCachedResponse(
    content: Array<LanguageModelV3Content>,
    finishReason: LanguageModelV3FinishReason,
    usage: LanguageModelV3Usage
  ): ReadableStream<LanguageModelV3StreamPart> {
    const parts: LanguageModelV3StreamPart[] = [];

    // Stream start
    parts.push({ type: 'stream-start', warnings: [] });

    // Process each content block
    let textIndex = 0;
    let toolIndex = 0;
    let reasoningIndex = 0;

    for (const block of content) {
      if (block.type === 'text') {
        const id = `text-${textIndex++}`;
        parts.push({ type: 'text-start', id });
        parts.push({ type: 'text-delta', id, delta: block.text });
        parts.push({ type: 'text-end', id });
      } else if (block.type === 'tool-call') {
        const id = `tool-${toolIndex++}`;
        parts.push({
          type: 'tool-input-start',
          id,
          toolName: block.toolName
        });
        parts.push({
          type: 'tool-input-delta',
          id,
          delta: block.input
        });
        parts.push({ type: 'tool-input-end', id });
        parts.push({
          type: 'tool-call',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          input: block.input,
        });
      } else if (block.type === 'reasoning') {
        const id = `reasoning-${reasoningIndex++}`;
        parts.push({ type: 'reasoning-start', id });
        parts.push({ type: 'reasoning-delta', id, delta: block.text });
        parts.push({ type: 'reasoning-end', id });
      }
    }

    // Finish event
    parts.push({ type: 'finish', usage, finishReason });

    // Create readable stream from the parts array
    return new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      }
    });
  }
}
