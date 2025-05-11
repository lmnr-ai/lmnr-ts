import {
  Attributes,
  AttributeValue,
  Context,
  context as contextApi,
  isSpanContextValid,
  Span,
  TimeInput,
  trace,
} from '@opentelemetry/api';

import { InitializeOptions, initializeTracing } from './opentelemetry-lib';
import { forceFlush, getTracer, patchModules } from './opentelemetry-lib/tracing/';
import {
  ASSOCIATION_PROPERTIES,
  LaminarAttributes,
  SESSION_ID,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
} from './opentelemetry-lib/tracing/attributes';
import { ASSOCIATION_PROPERTIES_KEY } from './opentelemetry-lib/tracing/utils';
import { LaminarSpanContext } from './types';
import {
  initializeLogger,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
  StringUUID,
  tryToOtelSpanContext,
} from './utils';

const logger = initializeLogger();

interface LaminarInitializeProps {
  projectApiKey?: string;
  baseUrl?: string;
  httpPort?: number;
  grpcPort?: number;
  instrumentModules?: InitializeOptions["instrumentModules"];
  preserveNextJsSpans?: boolean;
  disableBatch?: boolean;
  traceExportTimeoutMillis?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  maxExportBatchSize?: number;
  forceHttp?: boolean;
}

type LaminarAttributesProp = Record<
  typeof LaminarAttributes[keyof typeof LaminarAttributes],
  AttributeValue
>;

export class Laminar {
  private static baseHttpUrl: string;
  private static projectApiKey: string;
  private static isInitialized: boolean = false;
  /**
   * Initialize Laminar context across the application.
   * This method must be called before using any other Laminar methods or decorators.
   *
   * @param {LaminarInitializeProps} props - Configuration object.
   * @param {string} props.projectApiKey - Laminar project api key. You can generate one by going
   * to the projects settings page on the Laminar dashboard.
   * If not specified, it will try to read from the LMNR_PROJECT_API_KEY environment variable.
   * @param {string} props.baseUrl - Laminar API url. Do not include the port, use
   * `httpPort` and `grpcPort` instead.
   * If not specified, defaults to https://api.lmnr.ai.
   * @param {number} props.httpPort - Laminar API http port.
   * If not specified, defaults to 443.
   * @param {number} props.grpcPort - Laminar API grpc port.
   * If not specified, defaults to 8443.
   * @param {InitializeOptions["instrumentModules"]} props.instrumentModules - Record
   * of modules to instrument.
   * If not specified, all auto-instrumentable modules will be instrumented, which include
   * LLM calls (OpenAI, Anthropic, etc), Langchain, VectorDB calls (Pinecone, Qdrant, etc).
   * Pass an empty object {} to disable any kind of automatic instrumentation.
   * If you only want to auto-instrument specific modules, then pass them in the object.
   * @param {boolean} props.disableBatch - Whether to disable batching of spans. Useful for debug
   * environments. If true, spans will be sent immediately using {@link SimpleSpanProcessor}
   * instead of {@link BatchSpanProcessor}.
   * @param {number} props.traceExportTimeoutMillis - Timeout for trace export.
   * Defaults to 30_000 (30 seconds),
   * which is over the default OTLP exporter timeout of 10_000 (10 seconds).
   * @param {string} props.logLevel - OTel log level. Defaults to "warn".
   * @param {number} props.maxExportBatchSize - Maximum number of spans to export in a single batch.
   * Ignored when `disableBatch` is true.
   * @param {boolean} props.forceHttp - Whether to force HTTP export. Not recommended.
   *
   * @example
   * import { Laminar } from '@lmnr-ai/lmnr';
   * import { OpenAI } from 'openai';
   * import * as ChainsModule from "langchain/chains";
   *
   * // Initialize Laminar while auto-instrumenting Langchain and OpenAI modules.
   * Laminar.initialize({
   *   projectApiKey: "<LMNR_PROJECT_API_KEY>",
   *   instrumentModules: {
   *     langchain: {
   *       chainsModule: ChainsModule
   *     },
   *     openAI: OpenAI
   *   }
   * });
   *
   * @throws {Error} - If project API key is not set
   */
  public static initialize({
    projectApiKey,
    baseUrl,
    httpPort,
    grpcPort,
    instrumentModules,
    disableBatch,
    traceExportTimeoutMillis,
    logLevel,
    maxExportBatchSize,
    forceHttp,
  }: LaminarInitializeProps = {}) {
    const key = projectApiKey ?? process?.env?.LMNR_PROJECT_API_KEY;
    if (key === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable',
      );
    }
    this.projectApiKey = key;
    const url = baseUrl ?? process?.env?.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const port = httpPort ?? (
      url.match(/:\d{1,5}$/g)
        ? parseInt(url.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const urlWithoutSlash = url.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    this.baseHttpUrl = `${urlWithoutSlash}:${port}`;

    this.isInitialized = true;

    initializeTracing({
      baseUrl: urlWithoutSlash,
      apiKey: this.projectApiKey,
      port: grpcPort,
      forceHttp,
      httpPort,
      silenceInitializationMessage: true,
      instrumentModules,
      logLevel: logLevel ?? "warn",
      disableBatch,
      maxExportBatchSize,
      traceExportTimeoutMillis,
    });
  }

  /**
   * Patch modules manually. Use this in setups where {@link Laminar.initialize()}
   * and in particular its `instrumentModules` option is not working, e.g. in
   * Next.js place Laminar initialize in `instrumentation.ts`, and then patch
   * the modules in server components or API routes.
   *
   * @param {InitializeOptions["instrumentModules"]} modules - Record of modules to instrument.
   */
  public static patch(modules: InitializeOptions["instrumentModules"]) {
    if (!this.isInitialized) {
      throw new Error("Laminar must be initialized before patching modules");
    }
    if (!modules || Object.keys(modules).length === 0) {
      throw new Error("Pass at least one module to patch");
    }
    patchModules(modules);
  }

  /**
   * Check if Laminar has been initialized. Utility to make sure other methods
   * are called after initialization.
   */
  public static initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Associates an event with the current span. If event with such name never
   * existed, Laminar will create a new event and infer its type from the value.
   * If the event already exists, Laminar will append the value to the event
   * if and only if the value is of a matching type. Otherwise, the event won't
   * be recorded. Supported types are string, number, and boolean. If the value
   * is `null`, event is considered a boolean tag with the value of `true`.
   *
   * @param {string} name - The name of the event.
   * @param {AttributeValue} value - The value of the event. Must be a primitive type. If not
   * specified, boolean true is assumed in the backend.
   * @param {TimeInput} timestamp - The timestamp of the event. If not specified, relies on
   * the underlying OpenTelemetry implementation.
   * If specified as an integer, it must be epoch nanoseconds.
   */
  public static event(
    name: string,
    value?: AttributeValue,
    timestamp?: TimeInput,
  ) {
    const currentSpan = trace.getActiveSpan();
    if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
      logger.warn("`Laminar().event()` called outside of span context." +
        ` Event '${name}' will not be recorded in the trace.` +
        " Make sure to annotate the function with a decorator",
      );
      return;
    }

    const event: Attributes = {
      "lmnr.event.type": "default",
    };
    if (value !== undefined) {
      event["lmnr.event.value"] = value;
    }

    currentSpan.addEvent(name, event, timestamp);
  }

  /**
   * Sets the session information for the current span and returns the
   * context to use for the following spans. Returns the result of the
   * function execution, so can be used in an `await` statement.
   *
   * @param {string} sessionId - The session ID to associate with the context.
   * @param {Function} fn - Function to execute within the session context.
   * @returns {T} The result of the function execution.
   *
   * @example
   * import { Laminar, observe } from '@lmnr-ai/lmnr';
   * const result = await Laminar.withSession("session1234", async () => {
   *   // Your code here
   * });
   */
  public static withSession<T>(
    sessionId: string,
    fn: () => T,
  ): T {
    const currentSpan = trace.getActiveSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      if (sessionId) {
        currentSpan.setAttribute(SESSION_ID, sessionId);
      }
    }
    let associationProperties = {};
    if (sessionId) {
      associationProperties = { ...associationProperties, "session_id": sessionId };
    }

    let entityContext = contextApi.active();
    const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY);
    if (associationProperties && Object.keys(associationProperties).length > 0) {
      entityContext = entityContext.setValue(
        ASSOCIATION_PROPERTIES_KEY,
        { ...(currentAssociationProperties ?? {}), ...associationProperties },
      );
    }
    return contextApi.with(entityContext, fn);
  }

  /**
   * Sets the metadata for the current span and returns the context to use for
   * the following spans. Returns the result of the function execution, so can
   * be used in an `await` statement.
   *
   * @param metadata - The metadata to associate with the context. Set of string key
   * string value pairs.
   * @param fn - Function to execute within the metadata context.
   * @returns The result of the function execution.
   *
   * @example
   * import { Laminar } from '@lmnr-ai/lmnr';
   * const result = await Laminar.withMetadata(
   *   {
   *     "my_metadata_key": "my_metadata_value"
   *   },
   *   async () => {
   *     // Your code here
   *   }
   * );
   */
  public static withMetadata<T>(
    metadata: Record<string, string>,
    fn: () => T,
  ): T {
    const currentSpan = trace.getActiveSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      for (const [key, value] of Object.entries(metadata)) {
        currentSpan.setAttribute(`${ASSOCIATION_PROPERTIES}.metadata.${key}`, value);
      }
    }
    let metadataAttributes = {};
    for (const [key, value] of Object.entries(metadata)) {
      metadataAttributes = { ...metadataAttributes, [`metadata.${key}`]: value };
    }

    let entityContext = contextApi.active();
    const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY);
    if (metadataAttributes && Object.keys(metadataAttributes).length > 0) {
      entityContext = entityContext.setValue(
        ASSOCIATION_PROPERTIES_KEY,
        { ...(currentAssociationProperties ?? {}), ...metadataAttributes },
      );
    }
    return contextApi.with(entityContext, fn);
  }

  /**
   * Set attributes for the current span. Useful for manual
   * instrumentation.
   * @param {LaminarAttributesProp} attributes - The attributes to set for the current span.
   *
   * @example
   * import { Laminar as L, observe } from '@lmnr-ai/laminar';
   * await observe({ name: 'mySpanName', spanType: 'LLM' }, async (msg: string) => {
   *   const response = await myCustomCallToOpenAI(msg);
   *   L.setSpanAttributes({
   *     [LaminarAttributes.PROVIDER]: 'openai',
   *     [LaminarAttributes.REQUEST_MODEL]: "requested_model",
   *     [LaminarAttributes.RESPONSE_MODEL]: response.model,
   *     [LaminarAttributes.INPUT_TOKEN_COUNT]: response.usage.prompt_tokens,
   *     [LaminarAttributes.OUTPUT_TOKEN_COUNT]: response.usage.completion_tokens,
   *   })
   * }, userMessage);
   */
  public static setSpanAttributes(
    attributes: LaminarAttributesProp,
  ) {
    const currentSpan = trace.getActiveSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      for (const [key, value] of Object.entries(attributes)) {
        currentSpan.setAttribute(key, value);
      }
    }
  }

  /**
   * Set the output of the current span. Useful for manual instrumentation.
   * @param output - Output of the span. Will be sent as an attribute, so must
   * be serializable to JSON.
   */
  public static setSpanOutput(output: any) {
    if (output == null) {
      return;
    }
    const currentSpan = trace.getActiveSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      currentSpan.setAttribute(SPAN_OUTPUT, JSON.stringify(output));
    }
  }

  /**
   * Start a new span, but don't set it as active. Useful for
   * manual instrumentation. If span type is 'LLM', you should report usage
   * manually. See {@link setSpanAttributes} for more information.
   *
   * @param {Object} options
   * @param {string} options.name - name of the span
   * @param {any} options.input - input to the span. Will be sent as an attribute, so must
   * be JSON serializable
   * @param {string} options.spanType - type of the span. Defaults to 'DEFAULT'
   * @param {Context} options.context - raw OpenTelemetry context to bind the span to.
   * @param {string} options.traceId - [EXPERIMENTAL] override the trace id for the span. If not
   * provided, uses the current trace id.
   * @returns The started span.
   *
   * @example
   * import { Laminar, observe } from '@lmnr-ai/lmnr';
   * const foo = async (span: Span) => {
   *   await Laminar.withSpan(span, async () => {
   *     await observe({ name: 'foo' }, async () => {
   *       // Your code here
   *     })
   *   })
   * };
   * const bar = async (span: Span) => {
   *   await Laminar.withSpan(span, async () => {
   *     await openai_client.chat.completions.create();
   *   })
   * };
   *
   * const parentSpan = Laminar.startSpan({name: "outer"});
   * foo(parentSpan);
   * await bar(parentSpan);
   * // IMPORTANT: Don't forget to end the span!
   * parentSpan.end();
   *
   * // Results in:
   * // | outer
   * // |  | foo
   * // |  |  | ...
   * // |  | bar
   * // |  |  | openai.chat
   */
  public static startSpan({
    name,
    input,
    spanType,
    context,
    parentSpanContext,
    labels,
  }: {
    name: string,
    input?: any,
    spanType?: 'LLM' | 'DEFAULT' | 'TOOL',
    context?: Context,
    parentSpanContext?: string | LaminarSpanContext,
    labels?: string[],
  }): Span {
    let entityContext = context ?? contextApi.active();
    if (parentSpanContext) {
      const spanContext = tryToOtelSpanContext(parentSpanContext);
      entityContext = trace.setSpan(entityContext, trace.wrapSpanContext(spanContext));
    }
    const labelProperties = labels ? { [`${ASSOCIATION_PROPERTIES}.labels`]: labels } : {};
    const attributes = {
      [SPAN_TYPE]: spanType ?? 'DEFAULT',
      ...labelProperties,
    };
    const span = getTracer().startSpan(name, { attributes }, entityContext);
    if (input) {
      span.setAttribute(SPAN_INPUT, JSON.stringify(input));
    }
    return span;
  }

  /**
   * A utility wrapper around OpenTelemetry's `context.with()`. Useful for
   * passing spans around in manual instrumentation:
   *
   * @param {Span} span - Parent span to bind the execution to.
   * @param {Function} fn - Function to execute within the span context.
   * @param {boolean} endOnExit - Whether to end the span after the function has
   * executed. Defaults to `false`. If `false`, you MUST manually call
   * `span.end()` at the end of the execution, so that spans are not lost.
   * @returns The result of the function execution.
   *
   * See {@link startSpan} docs for a usage example
   */
  public static withSpan<T>(span: Span, fn: () => T, endOnExit?: boolean): T | Promise<T> {
    return contextApi.with(trace.setSpan(contextApi.active(), span), () => {
      try {
        const result = fn();
        if (result instanceof Promise) {
          return result.finally(() => {
            if (endOnExit !== undefined && endOnExit) {
              span.end();
            }
          });
        }
        if (endOnExit !== undefined && endOnExit) {
          span.end();
        }
        return result;
      }
      catch (error) {
        span.recordException(error as Error);
        if (endOnExit !== undefined && endOnExit) {
          span.end();
        }
        throw error;
      }
    });
  }

  public static serializeLaminarSpanContext(span?: Span): string | null {
    const laminarSpanContext = this.getLaminarSpanContext(span);
    if (laminarSpanContext === null) {
      return null;
    }
    return JSON.stringify(laminarSpanContext);
  };

  public static getLaminarSpanContext(span?: Span): LaminarSpanContext | null {
    const currentSpan = span ?? trace.getActiveSpan();
    if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
      return null;
    }
    return {
      traceId: otelTraceIdToUUID(currentSpan.spanContext().traceId) as StringUUID,
      spanId: otelSpanIdToUUID(currentSpan.spanContext().spanId) as StringUUID,
      isRemote: currentSpan.spanContext().isRemote ?? false,
    };
  }

  public static async flush() {
    if (this.isInitialized) {
      logger.debug("Flushing spans");
      await forceFlush();
    }
  }

  public static async shutdown() {
    if (this.isInitialized) {
      logger.debug("Shutting down Laminar");
      await forceFlush();
      // other shutdown should go here
    }
  }

  public static getHttpUrl(): string {
    return this.baseHttpUrl;
  }

  public static getProjectApiKey(): string {
    return this.projectApiKey;
  }
}
