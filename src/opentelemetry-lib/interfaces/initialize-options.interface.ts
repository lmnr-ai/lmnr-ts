import type * as anthropic from "@anthropic-ai/sdk";
import type * as bedrock from "@aws-sdk/client-bedrock-runtime";
import type * as azure from "@azure/openai";
import type * as StagehandLib from "@browserbasehq/stagehand";
import type * as aiplatform from "@google-cloud/aiplatform";
import type * as vertexAI from "@google-cloud/vertexai";
import type * as RunnableModule from "@langchain/core/runnables";
import type * as VectorStoreModule from "@langchain/core/vectorstores";
import { ContextManager, TextMapPropagator } from "@opentelemetry/api";
import { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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

/**
 * Options for initializing the Traceloop SDK.
 */
export interface InitializeOptions {
  /**
   * The API Key for sending traces data. Optional.
   */
  apiKey?: string;

  /**
   * The OTLP endpoint for sending traces data. Optional.
   * Defaults to TRACELOOP_BASE_URL environment variable or https://api.traceloop.com/
   */
  baseUrl?: string;

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
   * Defaults to warn.
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
    openAI?: typeof openai.OpenAI;
    anthropic?: typeof anthropic;
    azureOpenAI?: typeof azure;
    cohere?: typeof cohere;
    bedrock?: typeof bedrock;
    google_vertexai?: typeof vertexAI;
    google_aiplatform?: typeof aiplatform;
    pinecone?: typeof pinecone;
    langchain?: {
      chainsModule?: typeof ChainsModule;
      agentsModule?: typeof AgentsModule;
      toolsModule?: typeof ToolsModule;
      runnablesModule?: typeof RunnableModule;
      vectorStoreModule?: typeof VectorStoreModule;
    };
    llamaIndex?: typeof llamaindex;
    chromadb?: typeof chromadb;
    qdrant?: typeof qdrant;
    playwright?: {
      chromium?: typeof playwright.chromium,
      firefox?: typeof playwright.firefox,
      webkit?: typeof playwright.webkit,
    },
    stagehand?: typeof StagehandLib.Stagehand,
    puppeteer?: typeof puppeteer,
    together?: typeof together,
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
}
