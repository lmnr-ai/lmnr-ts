/**
 * OpenTelemetry SDK types (imported as needed by implementations)
 */
export type SpanExporter = any; // from @opentelemetry/sdk-trace-base
export type SpanProcessor = any; // from @opentelemetry/sdk-trace-base

import type { SessionRecordingOptions } from "./browser";

/**
 * Options for initializing the Laminar SDK.
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
   * The OTLP gRPC port for sending traces data. Optional.
   * Defaults to 8443.
   */
  grpcPort?: number;

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
  instrumentModules?: {
    /**
     * @deprecated Use `OpenAI` instead for consistent casing.
     */
    openAI?: any;
    OpenAI?: any;
    anthropic?: any;
    azureOpenAI?: any;
    cohere?: any;
    bedrock?: any;
    google_vertexai?: any;
    google_aiplatform?: any;
    pinecone?: any;
    langchain?: {
      agentsModule?: any;
      chainsModule?: any;
      runnablesModule?: any;
      toolsModule?: any;
      vectorStoreModule?: any;
    };
    llamaIndex?: any;
    chromadb?: any;
    qdrant?: any;
    playwright?: {
      chromium?: any;
      firefox?: any;
      webkit?: any;
    };
    puppeteer?: any;
    together?: any;
    kernel?: any;
    claudeAgentSDK?: {
      query?: any;
    };
    stagehand?: any;
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

  /**
   * The span processor to use. Warning: many other options will be ignored if this is provided.
   * Optional. Defaults to a new LaminarSpanProcessor.
   */
  spanProcessor?: SpanProcessor;
}
