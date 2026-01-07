import { context, trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import {
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { version as SDK_VERSION } from "../../../package.json";
import { initializeLogger } from "../../utils";
import { _configuration } from "../configuration";
import { InitializeOptions } from "../interfaces";
import { createResource } from "./compat";
import { waitForPendingStreams } from "./decorators";
import { initializeLaminarInstrumentations } from "./instrumentations";
import { LaminarSpanProcessor } from "./processor";
import { LaminarTracer } from "./tracer";
import { isGlobalContextManagerConfigured } from "./utils";

const logger = initializeLogger();

let spanProcessor: LaminarSpanProcessor;
let tracerProvider: TracerProvider | undefined;
let _baseHttpUrl: string = "https://api.lmnr.ai:443";
let _apiKey: string | undefined;

/**
 * Initializes the Tracing SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions}
 * for details.
 */
export const startTracing = (options: InitializeOptions) => {
  _baseHttpUrl = `${options.baseHttpUrl ?? options.baseUrl}:${options.httpPort ?? 443}`;
  _apiKey = options.apiKey;

  const instrumentations = initializeLaminarInstrumentations({
    baseUrl: _baseHttpUrl,
    apiKey: _apiKey,
    suppressContentTracing: !shouldSendTraces(),
    instrumentModules: options.instrumentModules,
    sessionRecordingOptions: options.sessionRecordingOptions,
  });

  const port = options.forceHttp ? options.httpPort : options.port;

  spanProcessor = new LaminarSpanProcessor({
    spanProcessor: options.spanProcessor,
    baseUrl: options.baseUrl,
    port,
    httpPort: options.httpPort,
    apiKey: options.apiKey,
    forceHttp: options.forceHttp,
    traceExportTimeoutMillis: options.traceExportTimeoutMillis,
    maxExportBatchSize: options.maxExportBatchSize,
    exporter: options.exporter,
    disableBatch: options.disableBatch,
  });

  const newProvider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
    sampler: new AlwaysOnSampler(),
    resource: createResource(
      {
        [ATTR_SERVICE_NAME]: "laminar-tracer-resource",
        [ATTR_SERVICE_VERSION]: SDK_VERSION,
      },
    ),
  });

  tracerProvider = newProvider;

  // Usually, we would do `tracerProvider.register()`, which does three things:
  // 1. Sets the global tracer provider
  // 2. Sets the global context manager to a default one, unless we specify a custom one
  // 3. Sets the global propagator to a default one, unless we specify a custom one
  // We don't do that, because Opentelemetry only allows setting these global
  // OTel API instances once.
  //
  // Instead, we do the following:
  // 1. Carry the global tracer provider around without globally registering it.
  //    - Set this tracer provider in the auto-instrumentations from OpenLLMetry
  //    - expose the `getTracer` function, which will return a tracer from our
  //      tracer provider.
  // 2. Set a context manager globally, only if we are the first ones to do so.
  //    - If we are not the first ones, we don't set the global context manager.
  //      - If an existing context manager is not broken, it suffices for our purposes
  //        for carrying the parent span context.
  //    - If any library tries to do so afterwards (and they will, e.g. @vercel/otel
  //      or @sentry/node do tracerProvider.register() internally), there will be
  //      an error message at their initialization.
  //      - We recommend to initialize Laminar after other tracing libraries to avoid that
  // 3. We don't do anything about the propagator, because no Laminar functionality
  //    depends on it. We might want to revisit this in the future w.r.t. `LaminarSpanContext`.

  // This is a small hack to only set the global context manager if there is none.
  if (!isGlobalContextManagerConfigured()) {
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    logger.debug('Laminar set global OTel Context Manager');
  }
  logger.debug('Global OTel Context Manager exists');


  logger.debug(`Laminar registering ${instrumentations.length} instrumentations`);
  // Similarly, we carry our global tracer provider around without globally
  // registering it.
  registerInstrumentations({
    instrumentations,
    tracerProvider: newProvider,
  });
};

export const patchModules = (modules: InitializeOptions["instrumentModules"]) => {
  const instrumentations = initializeLaminarInstrumentations({
    baseUrl: _baseHttpUrl,
    apiKey: _apiKey,
    instrumentModules: modules,
    suppressContentTracing: !shouldSendTraces(),
    sessionRecordingOptions: _configuration?.sessionRecordingOptions,
  });
  registerInstrumentations({
    instrumentations,
    tracerProvider: tracerProvider,
  });
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

/**
 * Get the tracer provider. Returns Laminar's tracer provider if Laminar is initialized,
 * otherwise returns the global tracer provider.
 * @returns The tracer provider.
 */
export const getTracerProvider = (): TracerProvider => tracerProvider ?? trace.getTracerProvider();

/**
 * Get the tracer.
 * @returns Laminar's tracer if Laminar is initialized,
 * otherwise returns Laminar's tracer from the global tracer provider
 *
 * @example
 * // instrumentation.ts
 * import { Laminar } from '@lmnr-ai/lmnr';
 * Laminar.initialize()
 *
 * // File that calls AI SDK.
 * import { getTracer } from '@lmnr-ai/lmnr';
 * import { openai } from "@ai-sdk/openai";
 * import { generateText } from "ai";
 *
 * const response = await generateText({
 *   model: openai("gpt-4.1-nano"),
 *   prompt: "What is the capital of France?",
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     tracer: getTracer(),
 *   }
 * })
 */
export const getTracer = (): Tracer => {
  const TRACER_NAME = "lmnr.tracer";
  const TRACER_VERSION = "0.0.1";
  const provider = getTracerProvider();
  return new LaminarTracer(provider.getTracer(TRACER_NAME, TRACER_VERSION));
};

/**
 * Get the span processor.
 * Used internally for setting parent path information when initializing from environment.
 * @returns The span processor, or undefined if not initialized.
 */
export const getSpanProcessor = (): LaminarSpanProcessor | undefined => spanProcessor;

export const forceFlush = async () => {
  // Wait for pending stream processing with 5 second timeout
  await waitForPendingStreams(5000);
  await spanProcessor.forceFlush();
};

export const clearSpanProcessor = () => {
  spanProcessor.clear();
};
