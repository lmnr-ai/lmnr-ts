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
import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FinishReason,
  type LanguageModelV4ResponseMetadata,
  type LanguageModelV4Usage,
  type SharedV4Headers,
  type SharedV4ProviderMetadata,
  type SharedV4Warning,
} from "@ai-sdk/provider-v4-canary";
import { CachedSpan } from "@lmnr-ai/types";

import { extractInputMessages } from "../../../debug/aisdk-normalize";
import { debugInputHash } from "../../../debug/hash";
import { getRuntime } from "../../../debug/index";
import { markSpanCached, replayEnabled } from "../../../debug/replay";
import { Laminar } from "../../../laminar";

type CacheResponse =
  | {
    type: "raw";
    response: Record<string, any> | Record<string, any>[];
    finishReasons?: string[] | null;
    model?: string | null;
  }
  | {
    type: "genAi";
    messages: Record<string, any>[];
    finishReasons?: string[] | null;
    model?: string | null;
  };

/**
 * Parsed HIT `output`. The server-side response shape is not yet frozen
 * (app-server plan 01 §4.3 stores EITHER the raw provider response OR a bare
 * `gen_ai.output.messages` array, and a discriminated {@link CacheResponse}
 * wrapper is the firmed-up form), so the consumer accepts all three and stays
 * tolerant rather than throwing on an unwrapped payload.
 */
type CacheOutput = CacheResponse | Record<string, any> | Record<string, any>[];

/**
 * Base class for Laminar language model wrappers.
 * Implements shared replay-cache logic for both V2 and V3 specifications.
 * Uses method overloads for type safety across versions.
 */
export abstract class BaseLaminarLanguageModel {
  protected readonly innerLanguageModel:
    | LanguageModelV2
    | LanguageModelV3
    | LanguageModelV4;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls:
    | PromiseLike<Record<string, RegExp[]>>
    | Record<string, RegExp[]>;

  constructor(
    languageModel: LanguageModelV2 | LanguageModelV3 | LanguageModelV4,
  ) {
    this.innerLanguageModel = languageModel;
    this.provider = languageModel.provider;
    this.modelId = languageModel.modelId;
    this.supportedUrls = languageModel.supportedUrls;
  }

  /**
   * Creates a version-specific usage object.
   * V2 and V3 have different usage structures, so this must be implemented by subclasses.
   */
  protected abstract createUsageObject():
    | LanguageModelV2Usage
    | LanguageModelV3Usage
    | LanguageModelV4Usage;

  /**
   * Creates a version-specific stream from cached response data.
   * V2 and V3 have different stream part types, so this must be implemented by subclasses.
   */
  protected abstract createStreamFromCachedResponse(
    content: Array<
      LanguageModelV2Content | LanguageModelV3Content | LanguageModelV4Content
    >,
    finishReason:
      | LanguageModelV2FinishReason
      | LanguageModelV3FinishReason
      | LanguageModelV4FinishReason,
    usage: LanguageModelV2Usage | LanguageModelV3Usage | LanguageModelV4Usage,
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
      response?: LanguageModelV2ResponseMetadata & {
        headers?: SharedV2Headers;
        body?: unknown;
      };
      warnings: Array<LanguageModelV2CallWarning>;
    }>,
  ): PromiseLike<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & {
      headers?: SharedV2Headers;
      body?: unknown;
    };
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
      response?: LanguageModelV3ResponseMetadata & {
        headers?: SharedV3Headers;
        body?: unknown;
      };
      warnings: Array<SharedV3Warning>;
    }>,
  ): PromiseLike<{
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    providerMetadata?: SharedV3ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV3ResponseMetadata & {
      headers?: SharedV3Headers;
      body?: unknown;
    };
    warnings: Array<SharedV3Warning>;
  }>;

  /**
   * Main generation method with caching support for V4
   */
  protected doGenerateWithCaching(
    options: LanguageModelV4CallOptions,
    doGenerateFn: (opts: LanguageModelV4CallOptions) => PromiseLike<{
      content: Array<LanguageModelV4Content>;
      finishReason: LanguageModelV4FinishReason;
      usage: LanguageModelV4Usage;
      providerMetadata?: SharedV4ProviderMetadata;
      request?: { body?: unknown };
      response?: LanguageModelV4ResponseMetadata & {
        headers?: SharedV4Headers;
        body?: unknown;
      };
      warnings: Array<SharedV4Warning>;
    }>,
  ): PromiseLike<{
    content: Array<LanguageModelV4Content>;
    finishReason: LanguageModelV4FinishReason;
    usage: LanguageModelV4Usage;
    providerMetadata?: SharedV4ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV4ResponseMetadata & {
      headers?: SharedV4Headers;
      body?: unknown;
    };
    warnings: Array<SharedV4Warning>;
  }>;

  /**
   * Implementation of doGenerateWithCaching
   * Consults the in-process replay cache (§G); falls through to the live call.
   */
  protected doGenerateWithCaching(
    options:
      | LanguageModelV2CallOptions
      | LanguageModelV3CallOptions
      | LanguageModelV4CallOptions,
    doGenerateFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    return this.doGenerateOrStreamWithCaching(options, doGenerateFn, (cached) =>
      this.cachedDoGenerate(cached),
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
    }>,
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
    }>,
  ): PromiseLike<{
    stream: ReadableStream<any>;
    request?: { body?: unknown };
    response?: { headers?: SharedV3Headers };
  }>;

  /**
   * Main streaming method with caching support for V4
   */
  protected doStreamWithCaching(
    options: LanguageModelV4CallOptions,
    doStreamFn: (opts: LanguageModelV4CallOptions) => PromiseLike<{
      stream: ReadableStream<any>;
      request?: { body?: unknown };
      response?: { headers?: SharedV4Headers };
    }>,
  ): PromiseLike<{
    stream: ReadableStream<any>;
    request?: { body?: unknown };
    response?: { headers?: SharedV4Headers };
  }>;

  /**
   * Implementation of doStreamWithCaching
   * Consults the in-process replay cache (§H); falls through to the live call.
   */
  protected doStreamWithCaching(
    options:
      | LanguageModelV2CallOptions
      | LanguageModelV3CallOptions
      | LanguageModelV4CallOptions,
    doStreamFn: (opts: any) => PromiseLike<any>,
  ): PromiseLike<any> {
    return this.doGenerateOrStreamWithCaching(options, doStreamFn, (cached) =>
      this.cachedDoStream(cached),
    );
  }

  /**
   * Common implementation for both doGenerateWithCaching and doStreamWithCaching.
   *
   * On a debug replay run, hashes this call's input messages and consults the
   * server-side replay cache (debug-replay v2, §9). Three outcomes:
   *   - HIT  — reconstruct the response from the cached span and mark CACHED.
   *   - MISS — latch process-wide live mode and run this (and every later) call
   *            live; the server records the response so the cache warms up.
   *   - LIVE — run THIS call live WITHOUT latching (server COLD warmup-timeout
   *            degrade, or any transport/parse error in the lookup).
   * A non-debug or no-replay run falls through to the live provider call.
   */
  private async doGenerateOrStreamWithCaching(
    options:
      | LanguageModelV2CallOptions
      | LanguageModelV3CallOptions
      | LanguageModelV4CallOptions,
    originalFn: (opts: any) => PromiseLike<any>,
    buildFromCached: (cached: CachedSpan) => any,
  ): Promise<any> {
    if (!replayEnabled() || Laminar.debugRunLive) {
      return originalFn(options);
    }

    // Reshape the prompt into the message array the server hashes, then hash it
    // (system message excluded) so the SDK and server key the cache identically.
    // A null/empty reshape means we could not reconstruct the prompt at all (a
    // stringify/JSON.parse failure, or no extractable messages). Hashing that
    // would key the lookup off the wrong bytes and force a spurious MISS, which
    // would wrongly latch live mode for the whole replay — so degrade to a live
    // call WITHOUT latching, exactly like a transport error in the lookup.
    const messages = extractInputMessages(options as { prompt: any });
    if (messages === null || messages.length === 0) {
      return originalFn(options);
    }
    const inputHash = debugInputHash(messages);
    const outcome = (await getRuntime()?.lookupCache(inputHash)) ?? {
      kind: "live" as const,
    };

    switch (outcome.kind) {
      case "hit":
        markSpanCached(Laminar.getCurrentSpan());
        return buildFromCached(outcome.cached);
      case "miss":
        // First MISS latches live mode for the rest of the process, so later
        // calls skip the lookup entirely and run live.
        Laminar.debugRunLive = true;
        return originalFn(options);
      case "live":
      default:
        return originalFn(options);
    }
  }

  private cachedDoGenerate(cached: CachedSpan): {
    content: Array<
      LanguageModelV2Content | LanguageModelV3Content | LanguageModelV4Content
    >;
    finishReason:
      | LanguageModelV2FinishReason
      | LanguageModelV3FinishReason
      | LanguageModelV4FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage | LanguageModelV4Usage;
    warnings: Array<
      LanguageModelV2CallWarning | SharedV3Warning | SharedV4Warning
    >;
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
    content: Array<
      LanguageModelV2Content | LanguageModelV3Content | LanguageModelV4Content
    >;
    finishReason:
      | LanguageModelV2FinishReason
      | LanguageModelV3FinishReason
      | LanguageModelV4FinishReason;
    usage: LanguageModelV2Usage | LanguageModelV3Usage | LanguageModelV4Usage;
  } {
    let parsedOutput: string | CacheOutput = cached.output;
    try {
      parsedOutput = JSON.parse(cached.output);
    } catch {
      // Ignore - keep as string
    }

    const content = this.convertToContentBlocks(parsedOutput);
    const usage = this.createUsageObject();
    const finishReason =
      cached.attributes["ai.response.finishReason"] ?? "stop";

    return { content, usage, finishReason };
  }

  /**
   * Converts output from span to content blocks compatible with both V2 and V3
   */
  private convertToContentBlocks(
    output: string | CacheOutput,
  ): Array<
    LanguageModelV4Content | LanguageModelV3Content | LanguageModelV2Content
  > {
    if (typeof output === "string") {
      return [
        {
          type: "text",
          text: output,
        },
      ];
    }

    // A JSON `null` / primitive payload has no content to replay and would crash
    // the wrapper / unwrap logic below (`output.type` on null throws). The
    // resource degrades a no-payload HIT to live, but parseCachedSpan can't —
    // so guard here too and emit an empty content array rather than throwing.
    if (output === null || typeof output !== "object") {
      return [];
    }

    // Handles a single content part. Covers both the v6 legacy shape
    // (`{type:"text", text}` / `{type:"tool_call", name, id, arguments}`) and the
    // v7 `gen_ai.output.messages` part shape (`{type:"text"|"thinking", content}` /
    // `{type:"tool_call", id, name, arguments}`), so `text` and `content` are both
    // accepted for the textual fields.
    const handleItem = (
      item: Record<string, any>,
    ): LanguageModelV3Content[] => {
      if (item.type === "text") {
        return [
          {
            type: "text",
            text: item.text ?? item.content ?? "",
          },
        ];
      }
      if (["tool-call", "tool_call"].includes(item.type)) {
        return [
          {
            type: "tool-call",
            toolCallId: item.toolCallId ?? item.id,
            toolName: item.toolName ?? item.name,
            input: JSON.stringify(item.input ?? item.arguments),
          },
        ];
      }
      if (["reasoning", "thinking"].includes(item.type)) {
        return [
          {
            type: "reasoning",
            text: item.text ?? item.content ?? "",
          },
        ];
      }
      return [
        {
          type: "text",
          text: JSON.stringify(item),
        },
      ];
    };

    // The HIT payload shape is not frozen (see CacheOutput): a discriminated
    // CacheResponse wrapper, a bare provider object, or a bare message array are
    // all possible. Unwrap the wrapper when present; otherwise treat the payload
    // itself as the content (array as-is, single object wrapped) so an unwrapped
    // server response replays instead of dereferencing a missing `.messages` /
    // `.response` and yielding `[undefined]`.
    let outputContent: Record<string, any>[];
    if (Array.isArray(output)) {
      outputContent = output;
    } else if (output.type === "genAi" && Array.isArray(output.messages)) {
      outputContent = output.messages;
    } else if (output.type === "raw" && "response" in output) {
      outputContent = Array.isArray(output.response)
        ? output.response
        : [output.response];
    } else {
      outputContent = [output];
    }
    return outputContent.flatMap((item) => {
      // v7 `gen_ai.output.messages` shape: `{role, parts:[...]}` (already an
      // object array, never a JSON string). Map each part through handleItem.
      if (item.role && Array.isArray(item.parts)) {
        return item.parts.flatMap(handleItem);
      }
      // v6 legacy shape: `{role, content}` where content is either an array of
      // parts or a JSON-encoded string of them.
      if (item.role && item.content) {
        let parsedContent: Record<string, any>[] = item.content;
        if (typeof item.content === "string") {
          try {
            parsedContent = JSON.parse(item.content);
          } catch {
            return [
              {
                type: "text",
                text: item.content,
              },
            ];
          }
        }
        return parsedContent.flatMap(handleItem);
      }
      return handleItem(item);
    });
  }
}
