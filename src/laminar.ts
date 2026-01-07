import {
  AttributeValue,
  Context,
  context as contextApi,
  isSpanContextValid,
  type Span,
  TimeInput,
  trace,
} from '@opentelemetry/api';
import { SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { InitializeOptions, initializeTracing, LaminarSpanProcessor } from './opentelemetry-lib';
import { _resetConfiguration } from './opentelemetry-lib/configuration';
import {
  forceReleaseProxy as forceReleaseClaudeProxy,
  instrumentClaudeAgentQuery,
} from './opentelemetry-lib/instrumentation/claude-agent-sdk';
import {
  forceFlush,
  getSpanProcessor,
  getTracer,
  patchModules,
} from './opentelemetry-lib/tracing';
import {
  ASSOCIATION_PROPERTIES,
  LaminarAttributes,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_TYPE,
  TRACE_TYPE,
  USER_ID,
} from './opentelemetry-lib/tracing/attributes';
import { LaminarContextManager } from './opentelemetry-lib/tracing/context';
import { LaminarSpan } from './opentelemetry-lib/tracing/span';
import {
  type LaminarSpanContext,
  type SessionRecordingOptions,
  type SpanType,
  type TraceType,
  TracingLevel,
} from './types';
import {
  deserializeLaminarSpanContext,
  initializeLogger,
  loadEnv,
  metadataToAttributes,
  type StringUUID,
  tryToOtelSpanContext,
  validateTracingConfig,
} from './utils';

loadEnv();

const logger = initializeLogger();

interface LaminarInitializeProps {
  projectApiKey?: string;
  baseUrl?: string;
  baseHttpUrl?: string;
  httpPort?: number;
  grpcPort?: number;
  instrumentModules?: InitializeOptions["instrumentModules"];
  disableBatch?: boolean;
  traceExportTimeoutMillis?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  maxExportBatchSize?: number;
  forceHttp?: boolean;
  sessionRecordingOptions?: SessionRecordingOptions;
  metadata?: Record<string, any>;
  inheritGlobalContext?: boolean;
  spanProcessor?: SpanProcessor;
}

type LaminarAttributesProp = Record<
  typeof LaminarAttributes[keyof typeof LaminarAttributes],
  AttributeValue
>;

export class Laminar {
  private static baseHttpUrl: string;
  private static projectApiKey: string;
  private static isInitialized: boolean = false;
  private static globalMetadata: Record<string, any> = {};
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
   * @param {string} props.baseHttpUrl - Laminar API http url. If not specified, defaults to
   * baseUrl. Only use this if you want to proxy HTTP requests through a different host.
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
   * @param {string} props.logLevel - OTel log level. Defaults to "error".
   * @param {number} props.maxExportBatchSize - Maximum number of spans to export in a single batch.
   * Ignored when `disableBatch` is true.
   * @param {boolean} props.forceHttp - Whether to force HTTP export. Not recommended.
   * @param {SessionRecordingOptions} props.sessionRecordingOptions - Options for browser
   * session recording.
   * Currently supports 'maskInputOptions' to control whether input fields are masked during
   * recording. Defaults to undefined (uses default masking behavior).
   * @param {Record<string, any>} props.metadata - Global metadata to associate with all spans.
   * This metadata will be associated with all spans, and merged with any metadata passed to
   * each span. Must be JSON serializable.
   * @param {boolean} props.inheritGlobalContext - Whether to inherit the global OpenTelemetry
   * context. Defaults to false. This is useful if your library is instrumented with OpenTelemetry
   * and you want Laminar spans to be children of the existing spans.
   * @param {SpanProcessor} props.spanProcessor - The span processor to use. If passed, some of
   * the other options will be ignored.
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
    baseHttpUrl,
    httpPort,
    grpcPort,
    instrumentModules,
    disableBatch,
    traceExportTimeoutMillis,
    logLevel,
    maxExportBatchSize,
    forceHttp,
    sessionRecordingOptions,
    metadata,
    inheritGlobalContext,
    spanProcessor,
  }: LaminarInitializeProps = {}) {
    if (this.isInitialized) {
      logger.warn("Laminar has already been initialized. Skipping initialization.");
      return;
    }
    const key = projectApiKey ?? process?.env?.LMNR_PROJECT_API_KEY;

    // Validate that either API key or OTEL configuration is present
    validateTracingConfig(key);

    this.projectApiKey = key ?? '';
    let url = baseUrl ?? process?.env?.LMNR_BASE_URL;

    // Only set default URL if we have an API key (traditional Laminar setup)
    if (key && !url) {
      url = 'https://api.lmnr.ai';
    }

    const httpUrl = baseHttpUrl ?? url;
    let port: number | undefined = httpPort;

    if (httpUrl) {
      if (!port) {
        const m = httpUrl.match(/:\d{1,5}$/g);
        port = m
          ? parseInt(m[0].slice(1))
          : 443;
      }
      const httpUrlWithoutSlash = httpUrl.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
      this.baseHttpUrl = `${httpUrlWithoutSlash}:${port}`;
    } else {
      this.baseHttpUrl = '';
    }

    this.globalMetadata = metadata ?? {};
    LaminarContextManager.setGlobalMetadata(this.globalMetadata);
    if (inheritGlobalContext) {
      LaminarContextManager.inheritGlobalContext = true;
    }
    if (spanProcessor && !(spanProcessor instanceof LaminarSpanProcessor)) {
      logger.warn(
        "Span processor is not a LaminarSpanProcessor. Some functionality may be impaired.",
      );
    }
    this.isInitialized = true;

    const urlWithoutSlash = url?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    const httpUrlWithoutSlash = httpUrl?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');

    initializeTracing({
      baseUrl: urlWithoutSlash,
      baseHttpUrl: httpUrlWithoutSlash,
      apiKey: key,
      port: grpcPort,
      forceHttp,
      httpPort,
      silenceInitializationMessage: true,
      instrumentModules,
      logLevel: logLevel ?? "error",
      disableBatch,
      maxExportBatchSize,
      traceExportTimeoutMillis,
      sessionRecordingOptions,
      spanProcessor,
    });

    this._initializeContextFromEnv();
  }

  /**
   * Initialize Laminar context from the LMNR_SPAN_CONTEXT environment variable.
   * This allows continuing traces across process boundaries.
   * @private
   */
  private static _initializeContextFromEnv(): void {
    const envContext = process?.env?.LMNR_SPAN_CONTEXT;
    if (!envContext) {
      return;
    }

    try {
      const laminarContext = deserializeLaminarSpanContext(envContext);

      // Convert to OpenTelemetry span context
      const otelSpanContext = tryToOtelSpanContext(laminarContext);
      // If we've parsed the context from the environment variable, it's remote
      otelSpanContext.isRemote = true;

      // Set parent path info in the span processor
      const processor = getSpanProcessor();
      if (processor
        && processor instanceof LaminarSpanProcessor
        && laminarContext.spanPath
        && laminarContext.spanIdsPath
      ) {
        processor.setParentPathInfo(
          otelSpanContext.spanId,
          laminarContext.spanPath,
          laminarContext.spanIdsPath,
        );
      }

      // Create a non-recording span and push the context
      const baseContext = trace.setSpan(
        LaminarContextManager.getContext(),
        trace.wrapSpanContext(otelSpanContext),
      );
      const ctx = LaminarContextManager.setRawAssociationProperties(laminarContext, baseContext);
      LaminarContextManager.pushContext(ctx);

      logger.debug("Initialized Laminar parent context from LMNR_SPAN_CONTEXT.");
    } catch (e) {
      logger.warn(
        "LMNR_SPAN_CONTEXT is set but could not be used: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * Patch modules manually. Use this in setups where {@link Laminar.initialize()}
   * and in particular its `instrumentModules` option is not working, e.g. in
   * Next.js place Laminar initialize in `instrumentation.ts`, and then patch
   * the modules in server components or API routes.
   *
   * Make sure to call this after {@link Laminar.initialize()}.
   *
   * @param {InitializeOptions["instrumentModules"]} modules - Record of modules to instrument.
   */
  public static patch(modules: InitializeOptions["instrumentModules"]) {
    if (!this.isInitialized) {
      logger.warn("Laminar must be initialized before patching modules. Skipping patch.");
      return;
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
   * Associates an event with the current span. If the event is created outside
   * of a span context, a new span is created and the event is associated with it.
   *
   * @param {object} options
   * @param {string} options.name - The name of the event.
   * @param {Record<string, AttributeValue>} options.attributes - The attributes of the event.
   * Values must be of a supported type.
   * @param {TimeInput} options.timestamp - The timestamp of the event. If not specified, relies on
   * the underlying OpenTelemetry implementation.
   * If specified as an integer, it must be epoch nanoseconds.
   * @param {string} options.sessionId - The session ID to associate with the event.
   * If not specified, the session ID of the current trace is used.
   * @param {string} options.userId - The user ID to associate with the event. If not specified,
   * the user ID of the current trace is used.
   */
  public static event({
    name,
    attributes,
    timestamp,
    sessionId,
    userId,
  }: {
    name: string,
    attributes?: Record<string, AttributeValue>,
    timestamp?: TimeInput,
    sessionId?: string,
    userId?: string,
  }) {
    if (!Laminar.initialized()) {
      return;
    }

    const allAttributes = {
      ...(attributes ?? {}),
      ...(sessionId ? { "lmnr.event.session_id": sessionId } : {}),
      ...(userId ? { "lmnr.event.user_id": userId } : {}),
    } as Record<string, AttributeValue>;

    const currentSpan = Laminar.getCurrentSpan();

    if (currentSpan === undefined) {
      const newSpan = Laminar.startSpan({ name });
      newSpan?.addEvent(name, allAttributes, timestamp);
      newSpan?.end();
      return;
    }

    currentSpan.addEvent(name, allAttributes, timestamp);
  }

  public static getCurrentSpan(
    context?: Context,
  ): LaminarSpan | undefined {
    const currentSpan = trace.getSpan(context ?? LaminarContextManager.getContext())
      ?? trace.getActiveSpan();
    if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
      return undefined;
    }
    if (currentSpan instanceof LaminarSpan) {
      return currentSpan;
    }
    return new LaminarSpan(currentSpan);
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
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
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
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      (currentSpan).setOutput(output);
    }
  }

  public static setTraceMetadata(metadata: Record<string, any>) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      (currentSpan).setTraceMetadata(metadata);
    }
  }

  public static setTraceSessionId(sessionId: string) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      (currentSpan).setTraceSessionId(sessionId);
    }
  }

  public static setTraceUserId(userId: string) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      (currentSpan).setTraceUserId(userId);
    }
  }

  public static setSpanTags(tags: string[]) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      (currentSpan).setTags(tags);
    }
  }

  public static addSpanTags(tags: string[]) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      (currentSpan).addTags(tags);
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
   * @param {string | LaminarSpanContext} options.parentSpanContext - parent span context
   * to bind the span to.
   * @param {string[]} options.tags - tags to associate with the span.
   * @param {string} options.userId - user ID to associate with the span.
   * @param {string} options.sessionId - session ID to associate with the span.
   * @param {Record<string, any>} options.metadata - metadata to associate with the span.
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
   * // |  | openai.chat
   */
  public static startSpan({
    name,
    input,
    spanType,
    context,
    parentSpanContext,
    tags,
    userId,
    sessionId,
    metadata,
    startTime,
  }: {
    name: string,
    input?: any,
    spanType?: SpanType,
    context?: Context,
    parentSpanContext?: string | LaminarSpanContext,
    tags?: string[],
    userId?: string,
    sessionId?: string,
    metadata?: Record<string, any>,
    startTime?: TimeInput,
  }): Span {
    return this._startSpan({
      name,
      input,
      spanType,
      context,
      parentSpanContext,
      tags,
      userId,
      sessionId,
      metadata,
      activated: false,
      startTime,
    });
  }

  /**
   * Start a new span, and set it as active. It is the caller's responsibility
   * to end the span. It is important to end the span, to avoid context mixing up.
   * We suggest ending the span in a finally block.
   * This is useful for manual instrumentation.
   * If span type is 'LLM', you should report usage manually.
   * See {@link setSpanAttributes} for more information.
   *
   * @param {Object} options
   * @param {string} options.name - name of the span
   * @param {any} options.input - input to the span. Will be sent as an attribute, so must
   * be JSON serializable
   * @param {string} options.spanType - type of the span. Defaults to 'DEFAULT'
   * @param {Context} options.context - raw OpenTelemetry context to bind the span to.
   * @param {string | LaminarSpanContext} options.parentSpanContext - parent span context
   * to bind the span to.
   * @param {string[]} options.tags - tags to associate with the span.
   * @param {string} options.userId - user ID to associate with the span.
   * @param {string} options.sessionId - session ID to associate with the span.
   * @param {Record<string, any>} options.metadata - metadata to associate with the span.
   * @returns The started span.
   *
   * @example
   * import { Laminar, observe } from '@lmnr-ai/lmnr';
   * const foo = async () => {
   *   await observe({ name: 'foo' }, async () => {
   *     // Your code here
   *   })
   * };
   * const bar = async (span: Span) => {
   *   await observe({ name: 'bar' }, async () => {
   *     await openai_client.chat.completions.create();
   *   })
   * };
   *
   * try {
   *   const parentSpan = Laminar.startActiveSpan({name: "outer"});
   *   foo();
   *   await bar();
   * } finally {
   *   parentSpan.end();
   * }
   *
   * // Results in:
   * // | outer
   * // |  | foo
   * // |  |  | ...
   * // |  | bar
   * // |  |  | openai.chat
   */
  public static startActiveSpan({
    name,
    input,
    spanType,
    context,
    parentSpanContext,
    tags,
    userId,
    sessionId,
    metadata,
    startTime,
  }: {
    name: string,
    input?: any,
    spanType?: SpanType,
    context?: Context,
    parentSpanContext?: string | LaminarSpanContext,
    tags?: string[],
    userId?: string,
    sessionId?: string,
    metadata?: Record<string, any>,
    startTime?: TimeInput,
  }): Span {
    return this._startSpan({
      name,
      input,
      spanType,
      context,
      parentSpanContext,
      tags,
      userId,
      sessionId,
      metadata,
      activated: true,
      startTime,
    });
  }

  private static _startSpan({
    name,
    input,
    spanType,
    context,
    parentSpanContext,
    tags,
    userId,
    sessionId,
    metadata,
    activated,
    startTime,
  }: {
    name: string,
    input?: any,
    spanType?: SpanType,
    context?: Context,
    parentSpanContext?: string | LaminarSpanContext,
    tags?: string[],
    userId?: string,
    sessionId?: string,
    metadata?: Record<string, any>,
    activated?: boolean,
    startTime?: TimeInput,
  }): Span {
    let entityContext = context ?? LaminarContextManager.getContext();

    // Extract parent path information before converting to OpenTelemetry span context
    let parentPath: string[] | undefined;
    let parentIdsPath: string[] | undefined;
    let parentMetadata: Record<string, any> | undefined;
    let parentTraceType: TraceType | undefined;
    let parentTracingLevel: TracingLevel | undefined;
    let parentUserId: string | undefined;
    let parentSessionId: string | undefined;

    if (parentSpanContext) {
      try {
        const laminarContext = typeof parentSpanContext === 'string'
          ? deserializeLaminarSpanContext(parentSpanContext)
          : parentSpanContext;

        parentPath = laminarContext.spanPath;
        parentIdsPath = laminarContext.spanIdsPath;
        parentMetadata = laminarContext.metadata;
        parentTraceType = laminarContext.traceType;
        parentTracingLevel = laminarContext.tracingLevel;
        parentUserId = laminarContext.userId;
        parentSessionId = laminarContext.sessionId;

        const spanContext = tryToOtelSpanContext(laminarContext);
        entityContext = trace.setSpan(entityContext, trace.wrapSpanContext(spanContext));
        LaminarContextManager.pushContext(entityContext);
      } catch (e) {
        logger.warn("Failed to parse parent span context: " +
          (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    const tagProperties = tags
      ? { [`${ASSOCIATION_PROPERTIES}.tags`]: Array.from(new Set(tags)) }
      : {};
    const ctxAssociationProperties = LaminarContextManager.getAssociationProperties();
    const userIdValue = userId
      ?? parentUserId
      ?? ctxAssociationProperties.userId;
    const sessionIdValue = sessionId
      ?? parentSessionId
      ?? ctxAssociationProperties.sessionId;
    const traceTypeValue = parentTraceType
      ?? ((spanType as string) === 'EVALUATION' ? 'EVALUATION' : undefined)
      ?? ctxAssociationProperties.traceType;
    const tracingLevelValue = parentTracingLevel
      ?? ctxAssociationProperties.tracingLevel;
    const ctxMetadata = ctxAssociationProperties.metadata;

    const userIdProperties = userIdValue ? { [USER_ID]: userIdValue } : {};
    const sessionIdProperties = sessionIdValue ? { [SESSION_ID]: sessionIdValue } : {};
    const traceTypeProperties = traceTypeValue ? { [TRACE_TYPE]: traceTypeValue } : {};
    const tracingLevelProperties = tracingLevelValue
      ? { [`${ASSOCIATION_PROPERTIES}.tracing_level`]: tracingLevelValue }
      : {};

    const mergedMetadata = {
      ...this.globalMetadata,
      ...ctxMetadata,
      ...parentMetadata,
      ...metadata,
    };

    const metadataProperties = metadataToAttributes(mergedMetadata);
    const attributes = {
      [SPAN_TYPE]: spanType ?? 'DEFAULT',
      ...tagProperties,
      ...userIdProperties,
      ...sessionIdProperties,
      ...metadataProperties,
      ...traceTypeProperties,
      ...tracingLevelProperties,
      ...(parentPath ? { [PARENT_SPAN_PATH]: parentPath } : {}),
      ...(parentIdsPath ? { [PARENT_SPAN_IDS_PATH]: parentIdsPath } : {}),
    };

    const span = getTracer().startSpan(name, { attributes, startTime }, entityContext);
    if (span instanceof LaminarSpan) {
      span.activated = activated ?? false;
    }

    if (input) {
      (span as LaminarSpan).setInput(input);
    }
    if (activated) {
      entityContext = LaminarContextManager.setAssociationProperties(
        span as LaminarSpan,
        entityContext,
      );
      entityContext = trace.setSpan(entityContext, span);
      LaminarContextManager.pushContext(entityContext);
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
  public static withSpan<T>(span: Span, fn: () => T, endOnExit?: boolean): T {
    const ctx = LaminarContextManager.getContext();
    const laminarSpan = new LaminarSpan(span);
    const ctxWithAssociationProperties = LaminarContextManager.setAssociationProperties(
      laminarSpan,
      ctx,
    );
    const context = trace.setSpan(ctxWithAssociationProperties, span);
    return contextApi.with(context, () => LaminarContextManager.runWithIsolatedContext(
      [context],
      () => {
        try {
          const result = fn();
          if (result instanceof Promise) {
            return result.catch((err) => {
              span.recordException(err as Error);
              throw err;
            }).finally(() => {
              if (endOnExit !== undefined && endOnExit) {
                span.end();
              }
            }) as T;
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
      },
    ));
  }

  public static serializeLaminarSpanContext(span?: Span): string | null {
    const laminarSpanContext = this.getLaminarSpanContext(span);
    if (laminarSpanContext === null) {
      return null;
    }
    return JSON.stringify(laminarSpanContext);
  };

  public static getLaminarSpanContext(span?: Span): LaminarSpanContext | null {
    let currentSpan = span ?? Laminar.getCurrentSpan();
    if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
      return null;
    }
    if (!(currentSpan instanceof LaminarSpan)) {
      currentSpan = new LaminarSpan(currentSpan);
    }
    return (currentSpan as LaminarSpan).getLaminarSpanContext();
  }

  /**
   * Get the trace id of the current span. Returns null if there is no active span.
   * @returns {StringUUID | null} The trace id of the current span.
   */
  public static getTraceId(): StringUUID | null {
    return this.getLaminarSpanContext()?.traceId ?? null;
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
      // Unlike Python where asynchronous nature of `BatchSpanProcessor.forceFlush()`
      // forces us to actually use `SpanProcessor.shutdown()` and make any
      // further interactions with OTEL API impossible, here we call
      // SpanProcessor.forceFlush() (and safely await it). Thus, users can
      // call `shutdown()` and then `initialize()` again. This is why we
      // reset the keys, contexts, and configuration here.
      this.isInitialized = false;
      _resetConfiguration();
      LaminarContextManager.clearContexts();
      LaminarContextManager.clearActiveSpans();

      // Force release the claude-code proxy if it was started (ignores ref count)
      forceReleaseClaudeProxy();
    }
  }

  public static getHttpUrl(): string {
    return this.baseHttpUrl;
  }

  public static getProjectApiKey(): string {
    return this.projectApiKey;
  }

  /**
   * Instrument the claude-agent-sdk query function.
   * Use this when you need to import the query function before calling Laminar.initialize().
   *
   * @param originalQuery - The original query function from @anthropic-ai/claude-agent-sdk
   * @returns The instrumented query function
   *
   * @example
   * ```typescript
   * import { query as originalQuery } from "@anthropic-ai/claude-agent-sdk";
   * import { Laminar } from "@lmnr-ai/lmnr";
   *
   * Laminar.initialize({ projectApiKey: "..." });
   *
   * const query = Laminar.instrumentClaudeAgentQuery(originalQuery);
   *
   * // Now use the instrumented query function
   * const result = query({ prompt: "Hello!" });
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  public static wrapClaudeAgentQuery<T extends Function>(originalQuery: T): T {
    return instrumentClaudeAgentQuery(originalQuery as any) as unknown as T;
  }
}
