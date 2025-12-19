import type * as AI from "ai";

import { getTracer } from "../tracing";
import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3ResponseMetadata,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Headers,
  SharedV3ProviderMetadata,
  SharedV3Warning
} from "@ai-sdk/provider-v3"
import { Laminar } from "../../laminar";
import { LaminarClient } from "../../client";
import { LaminarContextManager } from "../tracing/context"
import { trace } from "@opentelemetry/api";

const AI_FUNCTIONS = [
  'generateText',
  'generateObject',
  'streamText',
  'streamObject',
  'embed',
  'embedMany',
];

export const wrapAISDK = (ai: typeof AI): typeof AI => {
  const wrapped: Record<string, any> = {};
  Object.entries(ai).forEach(([key, value]) => {
    if (typeof value === 'function' && AI_FUNCTIONS.includes(key)) {
      const originalFn = value as (...args: any[]) => any;
      wrapped[key] = (...args: any[]) => {
        if (args[0] && typeof args[0] === 'object') {
          const defaultTelemetry = {
            isEnabled: true,
            tracer: getTracer(),
          };
          args[0] = {
            ...args[0],
            experimental_telemetry: {
              ...defaultTelemetry,
              ...args[0].experimental_telemetry,
            },
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return originalFn(...args);
      };
    } else {
      wrapped[key] = value;
    }
  });
  return wrapped as typeof AI;
};

const convertToContentBlocks = (output: string | Record<string, any>[]): Array<LanguageModelV3Content | LanguageModelV2Content> => {
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
  }

  return output.flatMap(item => {
    if (item.role && item.content) {
      let parsedContent: Record<string, any>[] = item.content;
      try {
        parsedContent = JSON.parse(item.content);
      } catch (error) {
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

class LaminarLanguageModelV3 { // implements LanguageModelV3
  readonly specificationVersion: 'v3' = 'v3';

  private readonly innerLanguageModel: LanguageModelV3;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;

  private pathToCount: Record<string, number> = {};
  private pathToCurrentIndex: Record<string, number> = {};
  private client: LaminarClient;

  constructor(languageModel: LanguageModelV3) {
    this.innerLanguageModel = languageModel;
    this.provider = languageModel.provider;
    this.modelId = languageModel.modelId;
    this.supportedUrls = languageModel.supportedUrls;
    const baseUrl = Laminar.getHttpUrl();
    const projectApiKey = Laminar.getProjectApiKey();
    this.client = new LaminarClient({
      baseUrl,
      projectApiKey,
    });
  }

  private async cachedDoGenerate(sessionId: string, path: string, index: number): Promise<undefined | {
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    warnings: Array<SharedV3Warning>;
  }> {
    const startTime = performance.now();
    const response = await this.client.rolloutSessions.get({
      sessionId,
      path,
      index,
    });

    if (!response) {
      return;
    }

    this.pathToCount = response.pathToCount;

    let parsedOutput: string | Record<string, any>[] = response.span.output;
    try {
      parsedOutput = JSON.parse(response.span.output);
    } catch (error) {
      // Ignore
    }
    const content = convertToContentBlocks(parsedOutput) as Array<LanguageModelV3Content>;
    return {
      usage: {
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
      },
      warnings: [],
      finishReason: response.span.attributes['ai.response.finishReason'] ?? 'stop',
      content,
    }
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
    if (process.env.LMNR_ROLLOUT_SESSION_ID) {
      const sessionId = process.env.LMNR_ROLLOUT_SESSION_ID;
      const pathArray = Laminar.getLaminarSpanContext()?.spanPath;
      if (pathArray) {
        const context = LaminarContextManager.getContext();
        const span = trace.getSpan(context);
        if (span) {
          span.setAttribute('lmnr.rollout.session_id', sessionId);
        }
        const path = pathArray.join('.');
        const currentIndex = this.pathToCurrentIndex[path] ?? 0;
        if (this.pathToCount[path] && currentIndex >= this.pathToCount[path]) {
          console.log('[exceeded count by path] returning original response');
          return this.innerLanguageModel.doGenerate(options);
        }
        this.pathToCurrentIndex[path] = currentIndex + 1;
        return this.cachedDoGenerate(sessionId, path, currentIndex).then(cachedResponse => {
          if (cachedResponse) {
            console.log('returning cached response');
            return cachedResponse;
          }
          console.log('returning original response');
          return this.innerLanguageModel.doGenerate(options);
        });
      }
    }
    return this.innerLanguageModel.doGenerate(options);
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
    return this.innerLanguageModel.doStream(options);
  }
}

class LaminarLanguageModelV2 { // implements LanguageModelV2
  readonly specificationVersion: 'v2' = 'v2';

  private readonly innerLanguageModel: LanguageModelV2;

  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;

  private pathToCount: Record<string, number> = {};
  private pathToCurrentIndex: Record<string, number> = {};
  private client: LaminarClient;

  constructor(languageModel: LanguageModelV2) {
    this.innerLanguageModel = languageModel;
    this.provider = languageModel.provider;
    this.modelId = languageModel.modelId;
    this.supportedUrls = languageModel.supportedUrls;
    const baseUrl = Laminar.getHttpUrl();
    const projectApiKey = Laminar.getProjectApiKey();
    this.client = new LaminarClient({
      baseUrl,
      projectApiKey,
    });
  }

  private async cachedDoGenerate(sessionId: string, path: string, index: number): Promise<undefined | {
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    const startTime = performance.now();
    const response = await this.client.rolloutSessions.get({
      sessionId,
      path,
      index,
    });

    if (!response) {
      return;
    }

    this.pathToCount = response.pathToCount;

    let parsedOutput: string | Record<string, any>[] = response.span.output;
    try {
      parsedOutput = JSON.parse(response.span.output);
    } catch (error) {
      // Ignore
    }
    const content = convertToContentBlocks(parsedOutput) as Array<LanguageModelV2Content>;
    return {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      warnings: [],
      finishReason: response.span.attributes['ai.response.finishReason'] ?? 'stop',
      content,
    }
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
    if (process.env.LMNR_ROLLOUT_SESSION_ID) {
      const sessionId = process.env.LMNR_ROLLOUT_SESSION_ID;
      const pathArray = Laminar.getLaminarSpanContext()?.spanPath;
      if (pathArray) {
        const context = LaminarContextManager.getContext();
        const span = trace.getSpan(context);
        if (span) {
          span.setAttribute('lmnr.rollout.session_id', sessionId);
        }
        const path = pathArray.join('.');
        const currentIndex = this.pathToCurrentIndex[path] ?? 0;
        if (this.pathToCount[path] && currentIndex >= this.pathToCount[path]) {
          console.log('[exceeded count by path] returning original response');
          return this.innerLanguageModel.doGenerate(options);
        }
        this.pathToCurrentIndex[path] = currentIndex + 1;
        return this.cachedDoGenerate(sessionId, path, currentIndex).then(cachedResponse => {
          if (cachedResponse) {
            console.log('returning cached response');
            return cachedResponse;
          }
          console.log('returning original response');
          return this.innerLanguageModel.doGenerate(options);
        });
      }
    }
    return this.innerLanguageModel.doGenerate(options);
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
    return this.innerLanguageModel.doStream(options);
  }
}

export function laminarLanguageModel(languageModel: LanguageModelV3): LanguageModelV3;
export function laminarLanguageModel(languageModel: LanguageModelV2): LanguageModelV2;
export function laminarLanguageModel(languageModel: LanguageModelV2 | LanguageModelV3): LanguageModelV2 | LanguageModelV3 {
  if (languageModel.specificationVersion === 'v3') {
    return new LaminarLanguageModelV3(languageModel as LanguageModelV3);
  }
  return new LaminarLanguageModelV2(languageModel as LanguageModelV2);
}
