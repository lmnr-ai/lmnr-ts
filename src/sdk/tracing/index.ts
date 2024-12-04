/* eslint-disable @typescript-eslint/no-var-requires */
import { baggageUtils } from "@opentelemetry/core";
import { ProxyTracerProvider, Span, TracerProvider, context, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Instrumentation } from "@opentelemetry/instrumentation";
import { InitializeOptions } from "../interfaces";
import {
  ASSOCIATION_PROPERTIES_KEY,
  SPAN_PATH_KEY,
} from "./tracing";
import { _configuration } from "../configuration";
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { AzureOpenAIInstrumentation } from "@traceloop/instrumentation-azure";
import { LlamaIndexInstrumentation } from "@traceloop/instrumentation-llamaindex";
import {
  AIPlatformInstrumentation,
  VertexAIInstrumentation,
} from "@traceloop/instrumentation-vertexai";
import { BedrockInstrumentation } from "@traceloop/instrumentation-bedrock";
import { CohereInstrumentation } from "@traceloop/instrumentation-cohere";
import { PineconeInstrumentation } from "@traceloop/instrumentation-pinecone";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import { ChromaDBInstrumentation } from "@traceloop/instrumentation-chromadb";
import { QdrantInstrumentation } from "@traceloop/instrumentation-qdrant";
import { ASSOCIATION_PROPERTIES, ASSOCIATION_PROPERTIES_OVERRIDES, SPAN_INSTRUMENTATION_SOURCE, SPAN_PATH } from "./attributes";

let _spanProcessor: SimpleSpanProcessor | BatchSpanProcessor;
let openAIInstrumentation: OpenAIInstrumentation | undefined;
let anthropicInstrumentation: AnthropicInstrumentation | undefined;
let azureOpenAIInstrumentation: AzureOpenAIInstrumentation | undefined;
let cohereInstrumentation: CohereInstrumentation | undefined;
let vertexaiInstrumentation: VertexAIInstrumentation | undefined;
let aiplatformInstrumentation: AIPlatformInstrumentation | undefined;
let bedrockInstrumentation: BedrockInstrumentation | undefined;
let langchainInstrumentation: LangChainInstrumentation | undefined;
let llamaIndexInstrumentation: LlamaIndexInstrumentation | undefined;
let pineconeInstrumentation: PineconeInstrumentation | undefined;
let chromadbInstrumentation: ChromaDBInstrumentation | undefined;
let qdrantInstrumentation: QdrantInstrumentation | undefined;


const instrumentations: Instrumentation[] = [];

const initInstrumentations = () => {
  const enrichTokens = false;

  openAIInstrumentation = new OpenAIInstrumentation({
    enrichTokens,
  });
  instrumentations.push(openAIInstrumentation);

  anthropicInstrumentation = new AnthropicInstrumentation();
  instrumentations.push(anthropicInstrumentation);

  azureOpenAIInstrumentation = new AzureOpenAIInstrumentation();
  instrumentations.push(azureOpenAIInstrumentation);

  cohereInstrumentation = new CohereInstrumentation();
  instrumentations.push(cohereInstrumentation);

  vertexaiInstrumentation = new VertexAIInstrumentation();
  instrumentations.push(vertexaiInstrumentation);

  aiplatformInstrumentation = new AIPlatformInstrumentation();
  instrumentations.push(aiplatformInstrumentation);

  bedrockInstrumentation = new BedrockInstrumentation();
  instrumentations.push(bedrockInstrumentation);

  pineconeInstrumentation = new PineconeInstrumentation();
  instrumentations.push(pineconeInstrumentation);

  langchainInstrumentation = new LangChainInstrumentation();
  instrumentations.push(langchainInstrumentation);

  llamaIndexInstrumentation = new LlamaIndexInstrumentation();
  instrumentations.push(llamaIndexInstrumentation);

  chromadbInstrumentation = new ChromaDBInstrumentation();
  instrumentations.push(chromadbInstrumentation);

  qdrantInstrumentation = new QdrantInstrumentation();
  instrumentations.push(qdrantInstrumentation);
};

const manuallyInitInstrumentations = (
  instrumentModules: InitializeOptions["instrumentModules"],
) => {
  const enrichTokens = false;

  instrumentations.length = 0;

  if (instrumentModules?.openAI) {
    openAIInstrumentation = new OpenAIInstrumentation({
      enrichTokens,
    });
    instrumentations.push(openAIInstrumentation);
    openAIInstrumentation.manuallyInstrument(instrumentModules.openAI);
  }

  if (instrumentModules?.anthropic) {
    anthropicInstrumentation = new AnthropicInstrumentation();
    instrumentations.push(anthropicInstrumentation);
    anthropicInstrumentation.manuallyInstrument(instrumentModules.anthropic);
  }

  if (instrumentModules?.azureOpenAI) {
    const instrumentation = new AzureOpenAIInstrumentation();
    instrumentations.push(instrumentation as Instrumentation);
    azureOpenAIInstrumentation = instrumentation;
    instrumentation.manuallyInstrument(instrumentModules.azureOpenAI);
  }

  if (instrumentModules?.cohere) {
    cohereInstrumentation = new CohereInstrumentation();
    instrumentations.push(cohereInstrumentation);
    cohereInstrumentation.manuallyInstrument(instrumentModules.cohere);
  }

  if (instrumentModules?.google_vertexai) {
    vertexaiInstrumentation = new VertexAIInstrumentation();
    instrumentations.push(vertexaiInstrumentation);
    vertexaiInstrumentation.manuallyInstrument(
      instrumentModules.google_vertexai,
    );
  }

  if (instrumentModules?.google_aiplatform) {
    aiplatformInstrumentation = new AIPlatformInstrumentation();
    instrumentations.push(aiplatformInstrumentation);
    aiplatformInstrumentation.manuallyInstrument(
      instrumentModules.google_aiplatform,
    );
  }

  if (instrumentModules?.bedrock) {
    bedrockInstrumentation = new BedrockInstrumentation();
    instrumentations.push(bedrockInstrumentation);
    bedrockInstrumentation.manuallyInstrument(instrumentModules.bedrock);
  }

  if (instrumentModules?.pinecone) {
    const instrumentation = new PineconeInstrumentation();
    instrumentations.push(instrumentation as Instrumentation);
    instrumentation.manuallyInstrument(instrumentModules.pinecone);
  }

  if (instrumentModules?.langchain) {
    langchainInstrumentation = new LangChainInstrumentation();
    instrumentations.push(langchainInstrumentation);
    langchainInstrumentation.manuallyInstrument(instrumentModules.langchain);
  }

  if (instrumentModules?.llamaIndex) {
    llamaIndexInstrumentation = new LlamaIndexInstrumentation();
    instrumentations.push(llamaIndexInstrumentation);
    llamaIndexInstrumentation.manuallyInstrument(instrumentModules.llamaIndex);
  }

  if (instrumentModules?.chromadb) {
    chromadbInstrumentation = new ChromaDBInstrumentation();
    instrumentations.push(chromadbInstrumentation);
    chromadbInstrumentation.manuallyInstrument(instrumentModules.chromadb);
  }

  if (instrumentModules?.qdrant) {
    qdrantInstrumentation = new QdrantInstrumentation();
    instrumentations.push(qdrantInstrumentation);
    qdrantInstrumentation.manuallyInstrument(instrumentModules.qdrant);
  }
};

/**
 * Initializes the Traceloop SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions} for details.
 */
export const startTracing = (options: InitializeOptions) => {
  if (options.instrumentModules !== undefined) {
    // If options.instrumentModules is empty, it will not initialize anything,
    // so empty dict can be passed to disable any kind of automatic instrumentation.
    manuallyInitInstrumentations(options.instrumentModules);
  } else {
    initInstrumentations();
  }

  if (!shouldSendTraces()) {
    openAIInstrumentation?.setConfig({
      traceContent: false,
    });
    azureOpenAIInstrumentation?.setConfig({
      traceContent: false,
    });
    llamaIndexInstrumentation?.setConfig({
      traceContent: false,
    });
    vertexaiInstrumentation?.setConfig({
      traceContent: false,
    });
    aiplatformInstrumentation?.setConfig({
      traceContent: false,
    });
    bedrockInstrumentation?.setConfig({
      traceContent: false,
    });
    cohereInstrumentation?.setConfig({
      traceContent: false,
    });
    chromadbInstrumentation?.setConfig({
      traceContent: false,
    });
  }

  const headers = process.env.TRACELOOP_HEADERS
    ? baggageUtils.parseKeyPairsIntoRecord(process.env.TRACELOOP_HEADERS)
    : { Authorization: `Bearer ${options.apiKey}` };

  const traceExporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${options.baseUrl}/v1/traces`,
      headers,
    });
  _spanProcessor = options.disableBatch
    ? new SimpleSpanProcessor(traceExporter)
    : new BatchSpanProcessor(traceExporter);

  _spanProcessor.onStart = (span: Span) => {
    const spanPath = context.active().getValue(SPAN_PATH_KEY);
    if (spanPath) {
      span.setAttribute(SPAN_PATH, spanPath as string);
    }

    span.setAttribute(SPAN_INSTRUMENTATION_SOURCE, "javascript");

    // This sets the properties only if the context has them
    const associationProperties = context
      .active()
      .getValue(ASSOCIATION_PROPERTIES_KEY);
    if (associationProperties) {
      for (const [key, value] of Object.entries(associationProperties)) {
        if (Object.keys(ASSOCIATION_PROPERTIES_OVERRIDES).includes(key)) {
          span.setAttribute(ASSOCIATION_PROPERTIES_OVERRIDES[key], value);
        } else if (key === "tracing_level") {
          span.setAttribute("lmnr.internal.tracing_level", value);
        } else {
          span.setAttribute(`${ASSOCIATION_PROPERTIES}.${key}`, value);
        }
      }
    }
  };

  if (options.useExternalTracerProvider) {
    const globalProvider = trace.getTracerProvider();
    let provider: TracerProvider;
    if (globalProvider instanceof ProxyTracerProvider) {
      provider = globalProvider.getDelegate() as NodeTracerProvider;
    } else {
      provider = globalProvider;
    }
    if ((provider as BasicTracerProvider).addSpanProcessor) {
      (provider as BasicTracerProvider).addSpanProcessor(_spanProcessor);
    } else {
      throw new Error("The active tracer provider does not support adding a span processor");
    }
  } else {
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(_spanProcessor);
    provider.register();
    registerInstrumentations({
      instrumentations,
      tracerProvider: provider,
    });
  }
};

export const shouldSendTraces = () => {
  if (!_configuration) {
    return false;
  }

  if (
    _configuration.traceContent === false ||
    (process.env.TRACELOOP_TRACE_CONTENT || "true").toLowerCase() === "false"
  ) {
    return false;
  }

  return true;
};

export const forceFlush = async () => {
  await _spanProcessor?.forceFlush();
};
