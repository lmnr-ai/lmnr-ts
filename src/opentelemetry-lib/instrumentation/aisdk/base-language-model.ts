import {
  type JSONSchema7,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3Message,
  type LanguageModelV3ProviderTool,
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
  type LanguageModelV2FunctionTool,
  type LanguageModelV2Message,
  type LanguageModelV2ProviderDefinedTool,
  type LanguageModelV2ResponseMetadata,
  type LanguageModelV2Usage,
  type SharedV2Headers,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider-v2";

import type { CacheServerResponse } from "../../../cli/rollout/cache-server";
import { Laminar } from "../../../laminar";
import type { LanguageModelTextBlock, LanguageModelToolDefinitionOverride } from "../../../types";
import { stringifyPromptForTelemetry } from "./utils";
/**
 * Base class for Laminar language model wrappers.
 * Implements shared caching and override logic for both V2 and V3 specifications.
 * Uses method overloads for type safety across versions.
 */
export abstract class BaseLaminarLanguageModel {
  protected readonly innerLanguageModel: LanguageModelV2 | LanguageModelV3;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;

  private pathToCount: Record<string, number> = {};
  private pathToCurrentIndex: Record<string, number> = {};
  private overrides: Record<string, {
    system?: string | Array<{ type: 'text'; text: string }>;
    tools?: Array<{ name: string; description?: string; parameters?: Record<string, any> }>;
  }> = {};
  private initialized: boolean = false;

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
   * Handles rollout session logic, path tracking, and cache lookups
   */
  protected doGenerateWithCaching(
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
    doGenerateFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    const sessionId = process.env.LMNR_ROLLOUT_SESSION_ID;
    if (sessionId) {
      return this.ensureInitialized().then(() => {
        const span = Laminar.getCurrentSpan();
        span?.setAttribute('lmnr.rollout.session_id', sessionId);
        const pathArray = Laminar.getLaminarSpanContext()?.spanPath;
        if (pathArray) {
          const path = pathArray.join('.');
          const currentIndex = this.pathToCurrentIndex[path] ?? 0;
          const optionsWithOverrides = this.applyOverrides(path, options);
          // By this time, we are already inside the .doGenerate span, and the
          // input attributes (ai.prompt.messages) and ai.prompt.tools have
          // already been set, and so we can override them here.
          span?.setAttribute(
            'ai.prompt.messages',
            stringifyPromptForTelemetry(optionsWithOverrides.prompt),
          );
          if (optionsWithOverrides.tools && optionsWithOverrides.tools.length > 0) {
            span?.setAttribute(
              'ai.prompt.tools',
              optionsWithOverrides.tools.map(tool => JSON.stringify(tool)),
            );
          }
          if (this.pathToCount[path] && currentIndex >= this.pathToCount[path]) {
            this.pathToCurrentIndex[path] = currentIndex + 1;
            return doGenerateFn(optionsWithOverrides);
          }
          this.pathToCurrentIndex[path] = currentIndex + 1;
          return this.cachedDoGenerate(path, currentIndex).then(cachedResponse => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return doGenerateFn(optionsWithOverrides);
          });
        }
        return doGenerateFn(options);
      });
    }
    return doGenerateFn(options);
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
   * Handles rollout session logic, path tracking, and cache lookups for streaming
   */
  protected doStreamWithCaching(
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
    doStreamFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    const sessionId = process.env.LMNR_ROLLOUT_SESSION_ID;
    if (sessionId) {
      return this.ensureInitialized().then(() => {
        const span = Laminar.getCurrentSpan();
        span?.setAttribute('lmnr.rollout.session_id', sessionId);
        const pathArray = Laminar.getLaminarSpanContext()?.spanPath;
        if (pathArray) {
          const path = pathArray.join('.');
          const currentIndex = this.pathToCurrentIndex[path] ?? 0;
          if (this.pathToCount[path] && currentIndex >= this.pathToCount[path]) {
            this.pathToCurrentIndex[path] = currentIndex + 1;
            const optionsWithOverrides = this.applyOverrides(path, options);
            // By this time, we are already inside the .doStream span, and the
            // input attributes (ai.prompt.messages) and ai.prompt.tools have
            // already been set, and so we can override them here.
            span?.setAttribute(
              'ai.prompt.messages',
              stringifyPromptForTelemetry(optionsWithOverrides.prompt),
            );
            if (optionsWithOverrides.tools && optionsWithOverrides.tools.length > 0) {
              span?.setAttribute(
                'ai.prompt.tools',
                optionsWithOverrides.tools.map(tool => JSON.stringify(tool)),
              );
            }
            return doStreamFn(optionsWithOverrides);
          }
          this.pathToCurrentIndex[path] = currentIndex + 1;
          return this.cachedDoStream(path, currentIndex).then(cachedStreamResult => {
            if (cachedStreamResult) {
              return cachedStreamResult;
            }
            return doStreamFn(this.applyOverrides(path, options as any));
          });
        }
        return doStreamFn(options);
      });
    }
    return doStreamFn(options);
  }

  /**
   * Ensures metadata is initialized by fetching (pathToCount, overrides) from cache server.
   * Only runs once per instance since each run event spawns a new worker process.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize by fetching metadata from cache server
    await this.fetchInitialMetadata();
    this.initialized = true;
  }

  /**
   * Fetches initial metadata (pathToCount, overrides) from cache server.
   */
  private async fetchInitialMetadata(): Promise<void> {
    const data = await this.fetchCachedSpan('', 0);
    if (data) {
      this.pathToCount = data.pathToCount;
      if (data.overrides) {
        this.overrides = data.overrides;
      }
    }
  }

  /**
   * Fetches and parses cached span data into content blocks, usage, and finish reason.
   * Updates pathToCount and overrides as a side effect.
   */
  private async fetchAndParseCachedSpan(
    path: string,
    index: number,
  ): Promise<undefined | {
    content: Array<LanguageModelV2Content | LanguageModelV3Content>;
    finishReason: LanguageModelV2FinishReason | LanguageModelV3FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage;
  }> {
    const data = await this.fetchCachedSpan(path, index);
    if (!data) {
      return;
    }

    // Update pathToCount and overrides from response (dynamic)
    this.pathToCount = data.pathToCount;
    if (data.overrides) {
      this.overrides = data.overrides;
    }

    if (!data.span) {
      return;
    }

    // Parse output
    let parsedOutput: string | Record<string, any>[] = data.span.output;
    try {
      parsedOutput = JSON.parse(data.span.output);
    } catch {
      // Ignore - keep as string
    }

    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      currentSpan.setAttributes({
        'lmnr.span.type': 'CACHED',
        'lmnr.span.original_type': 'LLM',
        'lmnr.rollout.session_id': process.env.LMNR_ROLLOUT_SESSION_ID,
        'lmnr.rollout.path.count': index + 1,
      });
    }

    const content = this.convertToContentBlocks(parsedOutput);
    const usage = this.createUsageObject();
    const finishReason = data.span.attributes['ai.response.finishReason'] ?? 'stop';

    return { content, usage, finishReason };
  }

  private async cachedDoGenerate(path: string, index: number): Promise<undefined | {
    content: Array<LanguageModelV2Content | LanguageModelV3Content>;
    finishReason: LanguageModelV2FinishReason | LanguageModelV3FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage;
    warnings: Array<LanguageModelV2CallWarning | SharedV3Warning>;
  }> {
    const parsed = await this.fetchAndParseCachedSpan(path, index);
    if (!parsed) {
      return;
    }

    return {
      ...parsed,
      warnings: [],
    };
  }

  private async cachedDoStream(path: string, index: number): Promise<undefined | {
    stream: ReadableStream<any>;
  }> {
    const parsed = await this.fetchAndParseCachedSpan(path, index);
    if (!parsed) {
      return;
    }

    // Create stream using version-specific implementation
    const stream = this.createStreamFromCachedResponse(
      parsed.content,
      parsed.finishReason,
      parsed.usage,
    );

    return { stream };
  }

  private applyOverrides(
    path: string,
    options: LanguageModelV2CallOptions | LanguageModelV3CallOptions,
  ): LanguageModelV2CallOptions | LanguageModelV3CallOptions {
    const pathOverride = this.overrides[path];
    if (!pathOverride) {
      return options;
    }

    const modifiedOptions = {
      ...options,
    } as LanguageModelV2CallOptions | LanguageModelV3CallOptions;

    // Apply system override
    const systemOverride = this.normalizeSystemOverride(pathOverride.system);
    if (systemOverride) {
      modifiedOptions.prompt =
        this.applySystemOverride(modifiedOptions.prompt, systemOverride) as any;
    }

    // Apply tool overrides
    if (pathOverride.tools) {
      modifiedOptions.tools =
        this.applyToolOverrides(modifiedOptions.tools, pathOverride.tools) as any;
    }

    return modifiedOptions;
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

  /**
   * Fetches cached span data from the local rollout cache server
   */
  private async fetchCachedSpan(
    path: string,
    index: number,
  ): Promise<CacheServerResponse | undefined> {
    const serverUrl = process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS;
    if (!serverUrl) {
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/cached`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path, index }),
      });

      if (!response.ok) {
        // 404 means cache miss
        return;
      }

      return await response.json() as CacheServerResponse;
    } catch {
      // Network error or other issues - return undefined to fall back to original model
      return;
    }
  }

  /**
   * Normalizes system override to a string
   */
  private normalizeSystemOverride(
    system: string | LanguageModelTextBlock[] | undefined,
  ): string | undefined {
    if (!system) {
      return undefined;
    }

    if (typeof system === 'string') {
      return system;
    }

    // Join text blocks into a single string
    return system.map(block => block.text ?? '').join('\n');
  }

  /**
   * Applies system message override to prompt
   */
  private applySystemOverride(
    prompt: Array<LanguageModelV2Message | LanguageModelV3Message>,
    systemOverride: string | undefined,
  ): Array<LanguageModelV2Message | LanguageModelV3Message> {
    if (!systemOverride) {
      return prompt;
    }

    // Filter out existing system messages
    const withoutSystem = prompt.filter(msg => msg.role !== 'system');

    // Add override as first message
    return [
      { role: 'system', content: systemOverride },
      ...withoutSystem,
    ];
  }

  /**
   * Applies tool overrides
   */
  private applyToolOverrides<
    F extends LanguageModelV2FunctionTool | LanguageModelV3FunctionTool,
    P extends LanguageModelV2ProviderDefinedTool | LanguageModelV3ProviderTool,
  >(
    tools: Array<F | P> | undefined,
    toolOverrides: LanguageModelToolDefinitionOverride[] | undefined,
  ): Array<F | P> | undefined {
    if (!toolOverrides || toolOverrides.length === 0) {
      return tools;
    }

    if (!tools || tools.length === 0) {
      // If no tools exist, create new tools from overrides that have inputSchema
      const newTools = [];
      for (const override of toolOverrides) {
        if (override.parameters) {
          newTools.push({
            type: 'function',
            name: override.name,
            description: override.description,
            inputSchema: override.parameters as JSONSchema7,
          });
        }
      }
      return newTools.length > 0 ? newTools as Array<F | P> : undefined;
    }

    const updatedTools = [...tools] as Array<F>;

    for (const override of toolOverrides) {
      const existingToolIndex = updatedTools.findIndex(
        tool => tool.type === 'function' && tool.name === override.name,
      );

      if (existingToolIndex !== -1) {
        const existingTool = updatedTools[existingToolIndex];
        // Merge with existing function tool (override takes priority)
        updatedTools[existingToolIndex] = {
          ...existingTool,
          description: override.description ?? existingTool.description,
          inputSchema: override.parameters
            ? (override.parameters as JSONSchema7)
            : (existingTool.inputSchema),
        };
      } else if (override.parameters) {
        // Add new tool if it has inputSchema
        updatedTools.push({
          type: 'function',
          name: override.name,
          description: override.description,
          inputSchema: override.parameters as JSONSchema7,
        } as F);
      }
    }

    return updatedTools;
  }
}
