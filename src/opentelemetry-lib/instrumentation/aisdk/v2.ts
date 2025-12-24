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
} from "@ai-sdk/provider-v2";
import { Laminar } from "../../../laminar";
import { LaminarClient } from "../../../client";
import { convertToContentBlocks, fetchCachedSpan } from "./shared";

export class LaminarLanguageModelV2 { // implements LanguageModelV2
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

  private async cachedDoGenerate(path: string, index: number): Promise<undefined | {
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: Array<LanguageModelV2CallWarning>;
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

    const content = convertToContentBlocks(parsedOutput) as Array<LanguageModelV2Content>;
    return {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      warnings: [],
      finishReason: data.span.attributes['ai.response.finishReason'] ?? 'stop',
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
      // const span = Laminar.getCurrentSpan();
      // span?.setAttribute('lmnr.rollout.session_id', process.env.LMNR_ROLLOUT_SESSION_ID);
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
