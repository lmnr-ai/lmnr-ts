import type * as anthropic from "@anthropic-ai/sdk";
import type * as bedrock from "@aws-sdk/client-bedrock-runtime";
import type * as azure from "@azure/openai";
import type * as aiplatform from "@google-cloud/aiplatform";
import type * as vertexAI from "@google-cloud/vertexai";
import type * as RunnableModule from "@langchain/core/runnables";
import type * as VectorStoreModule from "@langchain/core/vectorstores";
import { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type * as pinecone from "@pinecone-database/pinecone";
import type * as qdrant from "@qdrant/js-client-rest";
import type * as chromadb from "chromadb";
import type * as cohere from "cohere-ai";
import type * as AgentsModule from "langchain/agents";
import type * as ChainsModule from "langchain/chains";
import type * as ToolsModule from "langchain/tools";
import type * as llamaindex from "llamaindex";
import type * as openai from "openai";
import type * as playwright from "playwright";
import type * as puppeteer from "puppeteer";
import type * as together from "together-ai";

import type { SessionRecordingOptions } from "../../types";

/**
 * Options for initializing the Traceloop SDK.
 */
export interface InitializeOptions {
  /**
   * The API Key for sending traces data. Optional.
   */
  apiKey?: string;

  /**
   * The Laminar API endpoint for sending traces data. Optional.
   * Defaults to https://api.lmnr.ai:8443
   */
  baseUrl?: string;

  /**
   * The Laminar API HTTP endpoint for sending traces data. Optional.
   * Defaults to baseUrl. Only use this if you want to proxy HTTP requests
   * through a different host.
   */
  baseHttpUrl?: string;

  /**
   * Whether to disable batching. Optional.
   * Defaults to false.
   */
  disableBatch?: boolean;

  /**
   * The OTLP gRPC port for sending traces data. Optional.
   * Defaults to 8443.
   */
  port?: number;

  /**
   * The HTTP port for sending traces data. Optional.
   * Defaults to 443.
   */
  httpPort?: number;

  /**
   * Whether to use HTTP for sending traces data. NOT RECOMMENDED. Optional.
   * Defaults to false.
   */
  forceHttp?: boolean;

  /**
   * Defines default log level for SDK and all instrumentations. Optional.
   * Defaults to error.
   */
  logLevel?: "debug" | "info" | "warn" | "error";

  /**
   * Whether to log prompts, completions and embeddings on traces. Optional.
   * Defaults to true.
   */
  traceContent?: boolean;

  /**
   * The modules to instrument. Optional. Suggested to use, if you don't see
   * the autoinstrumentation working.
   */
  // In case of version mismatch, types are not resolved correctly.
  // So we use any for now.

  instrumentModules?: {
    /**
     * @deprecated Use `OpenAI` instead for consistent casing.
     */
    openAI?: typeof openai.OpenAI;
    /**
     * @example
     * ```javascript
     * import { OpenAI } from "openai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { OpenAI: OpenAI },
     * });
     * ```
     */
    OpenAI?: typeof openai.OpenAI;
    /**
     * @example
     * ```javascript
     * import anthropic from "@anthropic-ai/sdk";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { anthropic },
     * });
     * ```
     */
    anthropic?: typeof anthropic;
    /**
     * @example
     * ```javascript
     * import azureOpenAI from "@azure/openai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { azureOpenAI },
     * });
     * ```
     */
    azureOpenAI?: typeof azure;
    /**
     * @example
     * ```javascript
     * import cohere from "cohere-ai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { cohere },
     * });
     * ```
     */
    cohere?: typeof cohere;
    /**
     * @example
     * ```javascript
     * import bedrock from "@aws-sdk/client-bedrock-runtime";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { bedrock },
     * });
     * ```
     */
    bedrock?: typeof bedrock;
    /**
     * @example
     * ```javascript
     * import vertexAI from "@google-cloud/vertexai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { vertexAI },
     * });
     * ```
     */
    google_vertexai?: typeof vertexAI;
    /**
     * @example
     * ```javascript
     * import aiplatform from "@google-cloud/aiplatform";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { aiplatform },
     * });
     * ```
     */
    google_aiplatform?: typeof aiplatform;
    /**
     * @example
     * ```javascript
     * import pinecone from "@pinecone-database/pinecone";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { pinecone },
     * });
     * ```
     */
    pinecone?: typeof pinecone;
    /**
     * @example
     * ```javascript
     * import ChainsModule from "langchain/chains";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: {
     *     langchain: {
     *       chainsModule: ChainsModule,
     *     },
     *   },
     * });
     * ```
     */
    langchain?: {
      agentsModule?: typeof AgentsModule;
      chainsModule?: typeof ChainsModule;
      runnablesModule?: typeof RunnableModule;
      toolsModule?: typeof ToolsModule;
      vectorStoreModule?: typeof VectorStoreModule;
    };
    /**
     * @example
     * ```javascript
     * import llamaindex from "llamaindex";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { llamaindex },
     * });
     * ```
     */
    llamaIndex?: typeof llamaindex;
    /**
     * @example
     * ```javascript
     * import chromadb from "chromadb";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { chromadb },
     * });
     * ```
     */
    chromadb?: typeof chromadb;
    /**
     * @example
     * ```javascript
     * import qdrant from "@qdrant/js-client-rest";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { qdrant },
     * });
     * ```
     */
    qdrant?: typeof qdrant;
    /**
     * @example
     * ```javascript
     * import { chromium } from "playwright";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: {
     *     playwright: {
     *       chromium,
     *     },
     *   },
     * });
     * ```
     */
    playwright?: {
      chromium?: typeof playwright.chromium,
      firefox?: typeof playwright.firefox,
      webkit?: typeof playwright.webkit,
    },
    /**
     * @example
     * ```javascript
     * import puppeteer from "puppeteer";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { puppeteer },
     * });
     * ```
     */
    puppeteer?: typeof puppeteer,
    /**
     * @example
     * ```javascript
     * import together from "together-ai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { together },
     * });
     * ```
     */
    together?: typeof together,
    /**
     * @example
     * ```javascript
     * import kernel from "@onkernel/sdk";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: { kernel },
     * });
     * ```
     */
    kernel?: any,
    /**
     * @example
     * ```javascript
     * import Stagehand from "@browserbasehq/stagehand";
     * import { OpenAI } from "openai";
     * import Laminar from "@lmnr-ai/lmnr";
     *
     * Laminar.initialize({
     *   instrumentModules: {
     *     stagehand: Stagehand,
     *     OpenAI: OpenAI,
     *   },
     * });
     * ```
     */
    stagehand?: any,
  };

  /**
   * Whether to silence the initialization message. Optional.
   * Defaults to false.
   */
  silenceInitializationMessage?: boolean;

  /**
   * Whether to reset the configuration. Optional.
   * Defaults to false.
   */
  _resetConfiguration?: boolean;

  /**
   * The maximum number of spans to export at a time. Optional.
   * Defaults to the default OTLP span processor batch size.
   * (512 at the time of writing)
   */
  maxExportBatchSize?: number;

  /**
   * The timeout for sending traces data. Optional.
   * Defaults to 30 seconds.
   */
  traceExportTimeoutMillis?: number;

  /**
   * The exporter to use. Warning: many other options will be ignored if this is provided. Optional.
   * Defaults to a new LaminarSpanExporter.
   */
  exporter?: SpanExporter;

  /**
   * Options for browser session recording. Currently supports 'maskInputOptions'
   * to control whether input fields are masked during recording.
   * Defaults to undefined (uses default masking behavior).
   */
  sessionRecordingOptions?: SessionRecordingOptions;
}
