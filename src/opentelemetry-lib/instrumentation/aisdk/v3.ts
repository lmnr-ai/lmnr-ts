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
} from "@ai-sdk/provider-v3";
import { Laminar } from "../../../laminar";
import { LaminarClient } from "../../../client";
import { convertToContentBlocks, fetchCachedSpan } from "./shared";

export class LaminarLanguageModelV3 { // implements LanguageModelV3
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

  private async cachedDoGenerate(path: string, index: number): Promise<undefined | {
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    warnings: Array<SharedV3Warning>;
  }> {
    const data = await fetchCachedSpan(path, index);
    if (!data) {
      return;
    }

    // Update pathToCount from response (dynamic)
    this.pathToCount = data.pathToCount;

    // Parse output
    let parsedOutput: string | Record<string, any>[] = data.span.output;
    try {
      parsedOutput = JSON.parse(data.span.output);
    } catch (error) {
      // Ignore - keep as string
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
      finishReason: data.span.attributes['ai.response.finishReason'] ?? 'stop',
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
      const pathArray = Laminar.getLaminarSpanContext()?.spanPath;
      if (pathArray) {
        const path = pathArray.join('.');
        const currentIndex = this.pathToCurrentIndex[path] ?? 0;
        if (this.pathToCount[path] && currentIndex >= this.pathToCount[path]) {
          console.log('[exceeded count by path] returning original response');
          return this.innerLanguageModel.doGenerate(options);
        }
        this.pathToCurrentIndex[path] = currentIndex + 1;
        return this.cachedDoGenerate(path, currentIndex).then(cachedResponse => {
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

