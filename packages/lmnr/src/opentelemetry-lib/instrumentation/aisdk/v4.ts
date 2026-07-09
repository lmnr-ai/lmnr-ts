import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FinishReason,
  type LanguageModelV4ResponseMetadata,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
  type SharedV4Headers,
  type SharedV4ProviderMetadata,
  type SharedV4Warning,
} from "@ai-sdk/provider";

import { BaseLaminarLanguageModel } from "./base-language-model";

export class LaminarLanguageModelV4
  extends BaseLaminarLanguageModel
  implements LanguageModelV4
{
  readonly specificationVersion = "v4";

  protected readonly innerLanguageModel: LanguageModelV4;

  constructor(languageModel: LanguageModelV4) {
    super(languageModel);
    this.innerLanguageModel = languageModel;
  }

  protected createUsageObject(): LanguageModelV4Usage {
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

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<{
    content: Array<LanguageModelV4Content>;
    finishReason: LanguageModelV4FinishReason;
    usage: LanguageModelV4Usage;
    providerMetadata?: SharedV4ProviderMetadata;
    request?: {
      body?: unknown;
    };
    response?: LanguageModelV4ResponseMetadata & {
      headers?: SharedV4Headers;
      body?: unknown;
    };
    warnings: Array<SharedV4Warning>;
  }> {
    return this.doGenerateWithCaching(options, (opts) =>
      this.innerLanguageModel.doGenerate(opts),
    );
  }

  doStream(options: LanguageModelV4CallOptions): PromiseLike<{
    stream: ReadableStream<LanguageModelV4StreamPart>;
    request?: {
      body?: unknown;
    };
    response?: {
      headers?: SharedV4Headers;
    };
  }> {
    return this.doStreamWithCaching(options, (opts) =>
      this.innerLanguageModel.doStream(opts),
    );
  }

  protected createStreamFromCachedResponse(
    content: Array<LanguageModelV4Content>,
    finishReason: LanguageModelV4FinishReason,
    usage: LanguageModelV4Usage,
  ): ReadableStream<LanguageModelV4StreamPart> {
    const parts: LanguageModelV4StreamPart[] = [];

    // Stream start
    parts.push({ type: "stream-start", warnings: [] });

    // Process each content block
    let textIndex = 0;
    let toolIndex = 0;
    let reasoningIndex = 0;

    // `providerMetadata` (and `providerExecuted` on tool calls) must survive
    // the rebuild: the AI SDK echoes these into the next step's prompt, and
    // the replay cache hashes that prompt — dropping them causes a spurious
    // MISS on the following step.
    for (const block of content) {
      if (block.type === "text") {
        const id = `text-${textIndex++}`;
        parts.push({
          type: "text-start",
          id,
          providerMetadata: block.providerMetadata,
        });
        parts.push({ type: "text-delta", id, delta: block.text });
        parts.push({ type: "text-end", id });
      } else if (block.type === "tool-call") {
        const id = `tool-${toolIndex++}`;
        parts.push({
          type: "tool-input-start",
          id,
          toolName: block.toolName,
        });
        parts.push({
          type: "tool-input-delta",
          id,
          delta: block.input,
        });
        parts.push({ type: "tool-input-end", id });
        parts.push({ ...block, type: "tool-call" });
      } else if (block.type === "reasoning") {
        const id = `reasoning-${reasoningIndex++}`;
        parts.push({
          type: "reasoning-start",
          id,
          providerMetadata: block.providerMetadata,
        });
        parts.push({ type: "reasoning-delta", id, delta: block.text });
        parts.push({ type: "reasoning-end", id });
      }
    }

    // Finish event
    parts.push({ type: "finish", usage, finishReason });

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
