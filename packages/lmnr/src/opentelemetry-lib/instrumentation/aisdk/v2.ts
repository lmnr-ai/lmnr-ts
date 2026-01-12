import {
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2ResponseMetadata,
  type LanguageModelV2StreamPart,
  type LanguageModelV2Usage,
  type SharedV2Headers,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider-v2";

import { BaseLaminarLanguageModel } from "./base-language-model";

export class LaminarLanguageModelV2 extends BaseLaminarLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';

  protected readonly innerLanguageModel: LanguageModelV2;

  constructor(languageModel: LanguageModelV2) {
    super(languageModel);
    this.innerLanguageModel = languageModel;
  }

  protected createUsageObject(): LanguageModelV2Usage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  doGenerate(options: LanguageModelV2CallOptions): PromiseLike<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: {
      body?: unknown;
    };
    response?: LanguageModelV2ResponseMetadata & {
      headers?: SharedV2Headers;
      body?: unknown;
    };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    return this.doGenerateWithCaching(
      options,
      (opts) => this.innerLanguageModel.doGenerate(opts),
    );
  }

  doStream(options: LanguageModelV2CallOptions): PromiseLike<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    request?: {
      body?: unknown;
    };
    response?: {
      headers?: SharedV2Headers;
    };
  }> {
    return this.doStreamWithCaching(
      options,
      (opts) => this.innerLanguageModel.doStream(opts),
    );
  }

  protected createStreamFromCachedResponse(
    content: Array<LanguageModelV2Content>,
    finishReason: LanguageModelV2FinishReason,
    usage: LanguageModelV2Usage,
  ): ReadableStream<LanguageModelV2StreamPart> {
    const parts: LanguageModelV2StreamPart[] = [];

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
          toolName: block.toolName,
        });
        parts.push({
          type: 'tool-input-delta',
          id,
          delta: block.input,
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
      },
    });
  }
}
