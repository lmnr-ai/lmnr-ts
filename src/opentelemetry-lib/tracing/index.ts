import { context, trace, TracerProvider } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import {
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";

import pino from "pino";
import pinoPretty from "pino-pretty";

import { version as SDK_VERSION } from "../../../package.json";
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { _configuration } from "../configuration";
import { InitializeOptions } from "../interfaces";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LaminarSpanProcessor } from "./processor";
import { createResource } from "./compat";
import { initializeLaminarInstrumentations } from "./instrumentations";
import { isGlobalContextManagerConfigured } from "./utils";

const logger = pino(pinoPretty({
  colorize: true,
  minimumLevel: "info",
}));

let spanProcessor: LaminarSpanProcessor;
let tracerProvider: TracerProvider | undefined;

/**
 * Initializes the Tracing SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions}
 * for details.
 */
export const startTracing = (options: InitializeOptions) => {
  const instrumentations = initializeLaminarInstrumentations({
    baseUrl: `${options.baseUrl}:${options.httpPort ?? 443}`,
    apiKey: options.apiKey,
    suppressContentTracing: !shouldSendTraces(),
    instrumentModules: options.instrumentModules,
  });

  const port = options.forceHttp ? options.httpPort : options.port;
  spanProcessor = new LaminarSpanProcessor({
    baseUrl: options.baseUrl,
    port,
    apiKey: options.apiKey,
    forceHttp: options.forceHttp,
    traceExportTimeoutMillis: options.traceExportTimeoutMillis,
    maxExportBatchSize: options.maxExportBatchSize,
    exporter: options.exporter,
    disableBatch: options.disableBatch,
  });

  logger.info(`Created LaminarSpanProcessor exporting to ${options.baseUrl}:${port}`);

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
    logger.info('Laminar set global OTel Context Manager');
  }
  logger.info('Global OTel Context Manager exists');


  logger.info(`Laminar registering ${instrumentations.length} instrumentations`);
  // Similarly, we carry our global tracer provider around without globally
  // registering it.
  registerInstrumentations({
    instrumentations,
    tracerProvider: newProvider,
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

export const getTracer = () => {
  const TRACER_NAME = "lmnr.tracer";
  const TRACER_VERSION = "0.0.1";
  const provider = tracerProvider ?? trace.getTracerProvider();
  return provider.getTracer(TRACER_NAME, TRACER_VERSION);
}

export const forceFlush = async () => {
  await spanProcessor.forceFlush();
}
