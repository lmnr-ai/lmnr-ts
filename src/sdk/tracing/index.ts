
import {
  Context,
  context,
  ProxyTracerProvider,
  trace,
  TracerProvider,
} from "@opentelemetry/api";
import { baggageUtils } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { Span } from "@opentelemetry/sdk-trace-base";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  NodeTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { AzureOpenAIInstrumentation } from "@traceloop/instrumentation-azure";
import { BedrockInstrumentation } from "@traceloop/instrumentation-bedrock";
import { ChromaDBInstrumentation } from "@traceloop/instrumentation-chromadb";
import { CohereInstrumentation } from "@traceloop/instrumentation-cohere";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import { LlamaIndexInstrumentation } from "@traceloop/instrumentation-llamaindex";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { PineconeInstrumentation } from "@traceloop/instrumentation-pinecone";
import { QdrantInstrumentation } from "@traceloop/instrumentation-qdrant";
import {
  AIPlatformInstrumentation,
  VertexAIInstrumentation,
} from "@traceloop/instrumentation-vertexai";
import pino from "pino";

import { version as SDK_VERSION } from "../../../package.json";
import { PlaywrightInstrumentation, StagehandInstrumentation } from "../../browser";
import { LaminarClient } from "../../client";
// for doc comment:
import { otelSpanIdToUUID } from "../../utils";
import { getLangVersion } from "../../version";
import { _configuration } from "../configuration";
import { InitializeOptions } from "../interfaces";
import {
  ASSOCIATION_PROPERTIES,
  ASSOCIATION_PROPERTIES_OVERRIDES,
  EXTRACTED_FROM_NEXT_JS,
  OVERRIDE_PARENT_SPAN,
  SPAN_IDS_PATH,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_PATH,
  SPAN_SDK_VERSION,
} from "./attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getSpanPath,
  SPAN_PATH_KEY,
} from "./tracing";

const logger = pino({
  level: "info",
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

let _spanProcessor: SimpleSpanProcessor | BatchSpanProcessor | SpanProcessor | undefined;
const _spanIdToPath: Map<string, string[]> = new Map();
const _spanIdLists: Map<string, string[]> = new Map();
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
let playwrightInstrumentation: PlaywrightInstrumentation | undefined;
let stagehandInstrumentation: StagehandInstrumentation | undefined;

const NUM_TRACKED_NEXTJS_SPANS = 10000;

const instrumentations: Instrumentation[] = [];

const initInstrumentations = (client: LaminarClient) => {
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

  playwrightInstrumentation = new PlaywrightInstrumentation(client);
  instrumentations.push(playwrightInstrumentation);

  stagehandInstrumentation = new StagehandInstrumentation(playwrightInstrumentation);
  instrumentations.push(stagehandInstrumentation);
};

const manuallyInitInstrumentations = (
  client: LaminarClient,
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

  if (instrumentModules?.playwright) {
    playwrightInstrumentation = new PlaywrightInstrumentation(client);
    instrumentations.push(playwrightInstrumentation);
    playwrightInstrumentation.manuallyInstrument(instrumentModules.playwright);
  }

  if (instrumentModules?.stagehand) {
    if (!playwrightInstrumentation) {
      playwrightInstrumentation = new PlaywrightInstrumentation(client);
      instrumentations.push(playwrightInstrumentation);
    }
    stagehandInstrumentation = new StagehandInstrumentation(playwrightInstrumentation);
    instrumentations.push(stagehandInstrumentation);
    stagehandInstrumentation.manuallyInstrument(instrumentModules.stagehand);
  }
};

const NEXT_JS_SPAN_ATTRIBUTES = [
  'next.span_name',
  'next.span_type',
  'next.clientComponentLoadCount',
  'next.page',
  'next.rsc',
  'next.route',
  'next.segment',
];

// Next.js instrumentation is very verbose and can result in
// a lot of noise in the traces. By default, Laminar
// will ignore the Next.js spans (looking at the attributes like `next.span_name`)
// and set the topmost non-Next span as the root span in the trace.
// Here's the set of possible attributes as of Next.js 15.1
// See also: https://github.com/vercel/next.js/blob/790efc5941e41c32bb50cd915121209040ea432c/packages/next/src/server/lib/trace/tracer.ts#L297
const isNextJsSpan = (span: ReadableSpan) =>
  NEXT_JS_SPAN_ATTRIBUTES.some(attr => span.attributes[attr] !== undefined);

/**
 * Initializes the Traceloop SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions}
 * for details.
 */
export const startTracing = (options: InitializeOptions) => {
  const client = new LaminarClient({
    baseUrl: options.baseUrl ?? 'https://api.lmnr.ai',
    projectApiKey: options.apiKey ?? process.env.LMNR_PROJECT_API_KEY!,
  });
  if (options.instrumentModules !== undefined) {
    // If options.instrumentModules is empty, it will not initialize anything,
    // so empty dict can be passed to disable any kind of automatic instrumentation.
    manuallyInitInstrumentations(client, options.instrumentModules);
  } else {
    initInstrumentations(client);
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
  _spanProcessor = options.processor ??
    (options.disableBatch
      ? new SimpleSpanProcessor(traceExporter)
      : new BatchSpanProcessor(traceExporter, {
        maxExportBatchSize: options.maxExportBatchSize,
      })
    );

  const nextJsSpanIds = new Set<string>();
  // In the program runtime, the set may become very large, so every now and then
  // we remove half of the elements from the set to keep it from growing too much.
  // We use the fact that JS Set preserves insertion order to remove the oldest elements.
  const addNextJsSpanId = (spanId: string) => {
    if (nextJsSpanIds.size >= NUM_TRACKED_NEXTJS_SPANS) {
      const toRemove = Array.from(nextJsSpanIds).slice(0, NUM_TRACKED_NEXTJS_SPANS / 2);
      toRemove.forEach(id => nextJsSpanIds.delete(id));
    }
    nextJsSpanIds.add(spanId);
  };

  const originalOnEnd = _spanProcessor.onEnd.bind(_spanProcessor);
  const originalOnStart = _spanProcessor.onStart.bind(_spanProcessor);

  _spanProcessor.onStart = (span: Span, parentContext: Context) => {
    const contextSpanPath = getSpanPath(parentContext ?? context.active());
    const parentSpanPath = contextSpanPath
      ?? (span.parentSpanId !== undefined
        ? _spanIdToPath.get(span.parentSpanId)
        : undefined);
    const spanId = span.spanContext().spanId;
    const parentSpanIdsPath = span.parentSpanId
      ? ((!options.preserveNextJsSpans && nextJsSpanIds.has(span.parentSpanId))
        ? []
        : _spanIdLists.get(span.parentSpanId) ?? [])
      : [];
    const spanPath = (!options.preserveNextJsSpans
      && span.parentSpanId && nextJsSpanIds.has(span.parentSpanId)
    )
      ? [span.name]
      : parentSpanPath ? [...parentSpanPath, span.name] : [span.name];
    const spanIdUuid = otelSpanIdToUUID(spanId);

    const spanIdsPath = parentSpanIdsPath ? [...parentSpanIdsPath, spanIdUuid] : [spanIdUuid];

    span.setAttribute(SPAN_IDS_PATH, spanIdsPath);
    _spanIdLists.set(spanId, spanIdsPath);

    span.setAttribute(SPAN_PATH, spanPath);
    context.active().setValue(SPAN_PATH_KEY, spanPath);
    _spanIdToPath.set(spanId, spanPath);

    span.setAttribute(SPAN_INSTRUMENTATION_SOURCE, "javascript");
    span.setAttribute(SPAN_SDK_VERSION, SDK_VERSION);
    if (getLangVersion()) {
      span.setAttribute(SPAN_LANGUAGE_VERSION, getLangVersion());
    }

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
    // OVERRIDE_PARENT_SPAN makes the current span the root span in the trace.
    // The backend looks for this attribute and deletes the parentSpanId if the
    // attribute is present. We do that to make the topmost non-Next.js span
    // the root span in the trace.
    if (span.parentSpanId
      && nextJsSpanIds.has(span.parentSpanId)
      && !options.preserveNextJsSpans
    ) {
      span.setAttribute(OVERRIDE_PARENT_SPAN, true);
      // to indicate that this span was originally parented by a Next.js span
      span.setAttribute(EXTRACTED_FROM_NEXT_JS, true);
    }
    originalOnStart(span, parentContext);
    // If we know by this time that this span is created by Next.js,
    // we add it to the set of nextSpanIds.
    if (isNextJsSpan(span) && !options.preserveNextJsSpans) {
      addNextJsSpanId(span.spanContext().spanId);
    }
  };

  _spanProcessor.onEnd = (span: ReadableSpan) => {
    // Sometimes we only have know that this span is a Next.js only at the end.
    // We add it to the set of nextSpanIds in that case. Also, we do not call
    // the original onEnd, so that we don't send it to the backend.
    if (
      (isNextJsSpan(span) || nextJsSpanIds.has(span.spanContext().spanId))
      && !options.preserveNextJsSpans
    ) {
      addNextJsSpanId(span.spanContext().spanId);
    } else {
      // By default, we call the original onEnd.
      originalOnEnd(span);
    }
  };

  // This is an experimental workaround for the issue where Laminar fails
  // to work when there is another tracer provider already initialized.
  // See: https://github.com/lmnr-ai/lmnr/issues/231
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
    // Default behavior, if no external tracer provider is used.
    const provider = new NodeTracerProvider({
      spanProcessors: [_spanProcessor],
    });
    try {
      provider.register();
    } catch {
      logger.error('Error registering tracer provider');
    }
    registerInstrumentations({
      instrumentations,
      tracerProvider: provider,
    });
  }
};

export const shouldSendTraces = () => {
  if (!_configuration) {
    /**
     * We've only seen this happen in Next.js where apparently
     * the initialization in `instrumentation.ts` somehow does not
     * respect `Object.freeze`. Unlike original OpenLLMetry/Traceloop,
     * we return true here, because we have other mechanisms
     * {@link withTracingLevel} to disable tracing inputs and outputs.
     */
    return true;
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
