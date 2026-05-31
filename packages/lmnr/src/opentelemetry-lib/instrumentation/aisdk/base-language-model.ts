import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3ResponseMetadata,
  type LanguageModelV3Usage,
  type SharedV3Headers,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import {
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2ResponseMetadata,
  type LanguageModelV2Usage,
  type SharedV2Headers,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider-v2";
import { CachedSpan } from "@lmnr-ai/types";

import { cachedPayloadFor, markSpanCached, replayEnabled } from "../../../debug/replay";
import { Laminar } from "../../../laminar";

/**
 * Base class for Laminar language model wrappers.
 * Implements shared replay-cache logic for both V2 and V3 specifications.
 * Uses method overloads for type safety across versions.
 */
export abstract class BaseLaminarLanguageModel {
  protected readonly innerLanguageModel: LanguageModelV2 | LanguageModelV3;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;

  constructor(languageModel: LanguageModelV2 | LanguageModelV3) {
    this.innerLanguageModel = languageModel;
    this.provider = languageModel.provider;
    this.modelId = languageModel.modelId;
    this.supportedUrls = languageModel.supportedUrls;
  }

  /**
   * Creates a version-specific usage object.
   * V2 and V3 have different usage structures, so this must be implemented by subclasses.
   */
  protected abstract createUsageObject(): LanguageModelV2Usage | LanguageModelV3Usage;

  /**
   * Creates a version-specific stream from cached response data.
   * V2 and V3 have different stream part types, so this must be implemented by subclasses.
   */
  protected abstract createStreamFromCachedResponse(
    content: Array<LanguageModelV2Content | LanguageModelV3Content>,
    finishReason: LanguageModelV2FinishReason | LanguageModelV3FinishReason,
    usage: LanguageModelV2Usage | LanguageModelV3Usage
  ): ReadableStream<any>;

  /**
   * Main generation method with caching support for V2
   */
  protected doGenerateWithCaching(
    options: LanguageModelV2CallOptions,
    doGenerateFn: (opts: LanguageModelV2CallOptions) => PromiseLike<{
      content: Array<LanguageModelV2Content>;
      finishReason: LanguageModelV2FinishReason;
      usage: LanguageModelV2Usage;
      providerMetadata?: SharedV2ProviderMetadata;
      request?: { body?: unknown };
      response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
      warnings: Array<LanguageModelV2CallWarning>;
    }>
  ): PromiseLike<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }>;

  /**
   * Main generation method with caching support for V3
   */
  protected doGenerateWithCaching(
    options: LanguageModelV3CallOptions,
    doGenerateFn: (opts: LanguageModelV3CallOptions) => PromiseLike<{
      content: Array<LanguageModelV3Content>;
      finishReason: LanguageModelV3FinishReason;
      usage: LanguageModelV3Usage;
      providerMetadata?: SharedV3ProviderMetadata;
      request?: { body?: unknown };
      response?: LanguageModelV3ResponseMetadata & { headers?: SharedV3Headers; body?: unknown };
      warnings: Array<SharedV3Warning>;
    }>
  ): PromiseLike<{
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    providerMetadata?: SharedV3ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV3ResponseMetadata & { headers?: SharedV3Headers; body?: unknown };
    warnings: Array<SharedV3Warning>;
  }>;

  /**
   * Implementation of doGenerateWithCaching
   * Consults the in-process replay cache (§G); falls through to the live call.
   */
  protected doGenerateWithCaching(
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
    doGenerateFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    return this.doGenerateOrStreamWithCaching(
      options,
      doGenerateFn,
      (cached) => this.cachedDoGenerate(cached),
    );
  }

  /**
   * Main streaming method with caching support for V2
   */
  protected doStreamWithCaching(
    options: LanguageModelV2CallOptions,
    doStreamFn: (opts: LanguageModelV2CallOptions) => PromiseLike<{
      stream: ReadableStream<any>;
      request?: { body?: unknown };
      response?: { headers?: SharedV2Headers };
    }>
  ): PromiseLike<{
    stream: ReadableStream<any>;
    request?: { body?: unknown };
    response?: { headers?: SharedV2Headers };
  }>;

  /**
   * Main streaming method with caching support for V3
   */
  protected doStreamWithCaching(
    options: LanguageModelV3CallOptions,
    doStreamFn: (opts: LanguageModelV3CallOptions) => PromiseLike<{
      stream: ReadableStream<any>;
      request?: { body?: unknown };
      response?: { headers?: SharedV3Headers };
    }>
  ): PromiseLike<{
    stream: ReadableStream<any>;
    request?: { body?: unknown };
    response?: { headers?: SharedV3Headers };
  }>;

  /**
   * Implementation of doStreamWithCaching
   * Consults the in-process replay cache (§H); falls through to the live call.
   */
  protected doStreamWithCaching(
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
    doStreamFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    return this.doGenerateOrStreamWithCaching(
      options,
      doStreamFn,
      (cached) => this.cachedDoStream(cached),
    );
  }

  /**
   * Common implementation for both doGenerateWithCaching and doStreamWithCaching.
   *
   * On a debug replay run, resolves the current span path and consults the
   * in-process replay cache (§G, §H). A cache hit reconstructs the response from
   * the cached span and marks the span CACHED; a miss (or a non-debug run) falls
   * through to the live provider call.
   */
  private doGenerateOrStreamWithCaching(
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
    originalFn: (opts: any) => PromiseLike<any>,
    buildFromCached: (cached: CachedSpan) => any,
  ): PromiseLike<any> {
    if (!replayEnabled()) {
      return originalFn(options);
    }

    const span = Laminar.getCurrentSpan();
    const spanPath = Laminar.getLaminarSpanContext()?.spanPath?.join('.') ?? null;
    const cached = cachedPayloadFor(spanPath);
    if (!cached) {
      return originalFn(options);
    }

    markSpanCached(span);
    return Promise.resolve(buildFromCached(cached));
  }

  private cachedDoGenerate(cached: CachedSpan): {
    content: Array<LanguageModelV2Content | LanguageModelV3Content>;
    finishReason: LanguageModelV2FinishReason | LanguageModelV3FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage;
    warnings: Array<LanguageModelV2CallWarning | SharedV3Warning>;
  } {
    return {
      ...this.parseCachedSpan(cached),
      warnings: [],
    };
  }

  private cachedDoStream(cached: CachedSpan): { stream: ReadableStream<any> } {
    const parsed = this.parseCachedSpan(cached);
    const stream = this.createStreamFromCachedResponse(
      parsed.content,
      parsed.finishReason,
      parsed.usage,
    );
    return { stream };
  }

  /**
   * Reconstructs content blocks, usage, and finish reason from a cached span.
   */
  private parseCachedSpan(cached: CachedSpan): {
    content: Array<LanguageModelV2Content | LanguageModelV3Content>;
    finishReason: LanguageModelV2FinishReason | LanguageModelV3FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage;
  } {
    let parsedOutput: string | Record<string, any>[] = cached.output;
    try {
      parsedOutput = JSON.parse(cached.output);
    } catch {
      // Ignore - keep as string
    }

    const content = this.convertToContentBlocks(parsedOutput);
    const usage = this.createUsageObject();
    const finishReason = cached.attributes['ai.response.finishReason'] ?? 'stop';

    return { content, usage, finishReason };
  }

  /**
  * Converts output from span to content blocks compatible with both V2 and V3
  */
  private convertToContentBlocks(
    output: string | Record<string, any>[],
  ): Array<LanguageModelV3Content | LanguageModelV2Content> {
    if (typeof output === 'string') {
      return [{
        type: 'text',
        text: output,
      }];
    }

    const handleItem = (item: Record<string, any>): LanguageModelV3Content[] => {
      if (item.type === 'text') {
        return [{
          type: 'text',
          text: item.text ?? '',
        }];
      }
      if (['tool-call', 'tool_call'].includes(item.type)) {
        return [{
          type: 'tool-call',
          toolCallId: item.toolCallId ?? item.id,
          toolName: item.toolName ?? item.name,
          input: JSON.stringify(item.input ?? item.arguments),
        }];
      }
      if (item.type === 'reasoning') {
        return [{
          type: 'reasoning',
          text: item.text ?? '',
        }];
      }
      return [{
        type: 'text',
        text: JSON.stringify(item),
      }];
    };

    return output.flatMap(item => {
      if (item.role && item.content) {
        let parsedContent: Record<string, any>[] = item.content;
        try {
          parsedContent = JSON.parse(item.content);
        } catch {
          if (typeof item === 'string') {
            return [{
              type: 'text',
              text: item,
            }];
          }
        }
        return parsedContent.flatMap(handleItem);
      }
      return handleItem(item);
    });
  }
}
