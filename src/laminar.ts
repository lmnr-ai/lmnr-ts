import {
  PipelineRunResponse,
  PipelineRunRequest,
  EvaluationDatapoint,
  InitEvaluationResponse,
  GetDatapointsResponse,
  SemanticSearchResponse
} from './types';
import {
  Attributes,
  AttributeValue,
  Context,
  context as contextApi,
  isSpanContextValid,
  Span,
  TimeInput,
  trace,
  TraceFlags
} from '@opentelemetry/api';
import { InitializeOptions, initializeTracing } from './sdk/node-server-sdk'
import { isStringUUID, otelSpanIdToUUID, otelTraceIdToUUID, StringUUID, uuidToOtelTraceId } from './utils';
import { Metadata } from '@grpc/grpc-js';
import { ASSOCIATION_PROPERTIES_KEY, getTracer } from './sdk/tracing/tracing';
import { forceFlush } from './sdk/node-server-sdk';
import {
  ASSOCIATION_PROPERTIES,
  OVERRIDE_PARENT_SPAN,
  SESSION_ID,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
  LaminarAttributes,
} from './sdk/tracing/attributes';
import {
  wrapPlaywrightBrowser,
  wrapPlaywrightContext,
  wrapPlaywrightPage,
} from './browser/playwright';
import { RandomIdGenerator } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

// for docstring
import { BasicTracerProvider, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ProxyTracerProvider } from '@opentelemetry/api';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';


interface LaminarInitializeProps {
  projectApiKey?: string;
  env?: Record<string, string>;
  baseUrl?: string;
  httpPort?: number;
  grpcPort?: number;
  instrumentModules?: InitializeOptions["instrumentModules"];
  preserveNextJsSpans?: boolean;
  disableBatch?: boolean;
  traceExportTimeoutMillis?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  useExternalTracerProvider?: boolean;
  maxExportBatchSize?: number;
}

export class Laminar {
  private static baseHttpUrl: string;
  private static baseGrpcUrl: string;
  private static projectApiKey: string;
  private static env: Record<string, string> = {};
  private static isInitialized: boolean = false;

  /**
   * Initialize Laminar context across the application.
   * This method must be called before using any other Laminar methods or decorators.
   *
   * @param project_api_key - Laminar project api key. You can generate one by going
   * to the projects settings page on the Laminar dashboard.
   * If not specified, it will try to read from the LMNR_PROJECT_API_KEY environment variable.
   * @param env - Default environment passed to `run` requests, unless overriden at request
   * time. Usually, model provider keys are stored here.
   * @param baseUrl - Laminar API url. Do not include the port, use
   * `httpPort` and `grpcPort` instead.
   * If not specified, defaults to https://api.lmnr.ai.
   * @param httpPort - Laminar API http port.
   * If not specified, defaults to 443.
   * @param grpcPort - Laminar API grpc port.
   * If not specified, defaults to 8443.
   * @param instrumentModules - List of modules to instrument.
   * If not specified, all auto-instrumentable modules will be instrumented, which include
   * LLM calls (OpenAI, Anthropic, etc), Langchain, VectorDB calls (Pinecone, Qdrant, etc).
   * Pass an empty object {} to disable any kind of automatic instrumentation.
   * If you only want to auto-instrument specific modules, then pass them in the object.
   * @param preserveNextJsSpans - Whether to preserve thorough/verbose spans created by Next.js.
   * By default, Laminar ignores the Next.js spans, but keeps spans nested within them.
   * @param disableBatch - Whether to disable batching of spans. Useful for debug
   * environments. If true, spans will be sent immediately using {@link SimpleSpanProcessor}
   * instead of {@link BatchSpanProcessor}.
   * @param traceExportTimeoutMillis - Timeout for trace export. Defaults to 30_000 (30 seconds),
   * which is over the default OTLP exporter timeout of 10_000 (10 seconds).
   * @param useExternalTracerProvider - [ADVANCED] Only use if you are using another
   * node-based tracer provider. Defaults to false.
   * If `true`, the SDK will not initialize its own tracer provider. Be very careful.
   * If you set this to `true`, but the external provider does not extend/implement 
   * {@link BasicTracerProvider} or is not a {@link ProxyTracerProvider} that internally
   * delegates to a {@link BasicTracerProvider}, the SDK will not function correctly.
   * The only setting this has been tested with is `@opentelemetry/auto-instrumentations-node`.
   * {@link https://opentelemetry.io/docs/zero-code/js/#configuring-the-module} - this 
   * initializes a {@link ProxyTracerProvider} internally which delegates to a 
   * {@link NodeTracerProvider}, which in turn, extends {@link BasicTracerProvider}.
   * 
   * @example
   * import { Laminar as L } from '@lmnr-ai/lmnr';
   * import { OpenAI } from 'openai';
   * import * as ChainsModule from "langchain/chains";
   * 
   * // Initialize Laminar while auto-instrumenting Langchain and OpenAI modules.
   * L.initialize({ projectApiKey: "<LMNR_PROJECT_API_KEY>", instrumentModules: {
   *  langchain: {
   *      chainsModule: ChainsModule
   *  },
   *  openAI: OpenAI
   * } });
   *
   * @throws {Error} - If project API key is not set
   */
  public static initialize({
    projectApiKey,
    env,
    baseUrl,
    httpPort,
    grpcPort,
    instrumentModules,
    useExternalTracerProvider,
    preserveNextJsSpans,
    disableBatch,
    traceExportTimeoutMillis,
    logLevel,
    maxExportBatchSize,
  }: LaminarInitializeProps) {

    let key = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
    if (key === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable'
      );
    }
    this.projectApiKey = key;
    if (baseUrl?.match(/:\d{1,5}$/g)) {
      throw new Error(
        'Port should be passed separately in `httpPort` and `grpcPort`'
      );
    }

    this.baseHttpUrl = `${baseUrl ?? 'https://api.lmnr.ai'}:${httpPort ?? 443}`;
    this.baseGrpcUrl = `${baseUrl ?? 'https://api.lmnr.ai'}:${grpcPort ?? 8443}`;

    this.isInitialized = true;
    this.env = env ?? {};

    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${this.projectApiKey}`);
    const exporter = new OTLPTraceExporter({
      url: `${this.baseGrpcUrl}`,
      metadata,
      // default is 10 seconds, increase to 30 seconds
      timeoutMillis: traceExportTimeoutMillis ?? 30000,
    });

    initializeTracing({
      exporter,
      silenceInitializationMessage: true,
      instrumentModules,
      disableBatch,
      useExternalTracerProvider,
      preserveNextJsSpans,
      logLevel: logLevel ?? "error",
      maxExportBatchSize,
    });
  }

  /**
   * Check if Laminar has been initialized. Utility to make sure other methods
   * are called after initialization.
   */
  public static initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Sets the environment that will be sent to Laminar requests.
   * 
   * @param env - The environment variables to override. If not provided, the
   * current environment will not be modified.
   */
  public static setEnv(env?: Record<string, string>) {
    if (env) {
      this.env = env;
    }
  }

  /**
   * Sets the project API key for authentication with Laminar.
   *
   * @param projectApiKey - The API key to be set. If not provided, the existing
   * API key will not be modified.
   */
  public static setProjectApiKey(projectApiKey?: string) {
    if (projectApiKey) {
      this.projectApiKey = projectApiKey;
    }
  }

  /**
   * Runs the pipeline with the given inputs
   *
   * @param pipeline - The name of the Laminar pipeline. Pipeline must have a target version.
   * @param inputs - The inputs for the pipeline. Map from an input node name to input data.
   * @param env - The environment variables for the pipeline execution.
   * Typically used for model provider keys.
   * @param metadata - Additional metadata for the pipeline run.
   * @param currentSpanId - The ID of the current span.
   * @param currentTraceId - The ID of the current trace.
   * @returns A promise that resolves to the response of the pipeline run.
   * @throws An error if the Laminar object is not initialized with a project API
   * key or if the request fails.
   */
  public static async run({
    pipeline,
    inputs,
    env,
    metadata = {},
    currentSpanId,
    currentTraceId,
  }: PipelineRunRequest): Promise<PipelineRunResponse> {
    const currentSpan = trace.getActiveSpan();
    let parentSpanId: string | undefined;
    let traceId: string | undefined;
    if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
      parentSpanId = currentSpanId ?? otelSpanIdToUUID(currentSpan.spanContext().spanId);
      traceId = currentTraceId ?? otelTraceIdToUUID(currentSpan.spanContext().traceId);
    } else {
      parentSpanId = currentSpanId;
      traceId = currentTraceId;
    }
    if (this.projectApiKey === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable'
      );
    }
    const envirionment = env === undefined ? this.env : env;

    const response = await fetch(`${this.baseHttpUrl}/v1/pipeline/run`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        inputs,
        pipeline,
        env: envirionment,
        metadata,
        parentSpanId,
        traceId,
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to run pipeline ${pipeline}. Response: ${response.statusText}`);
    }
    try {
      return await response.json() as PipelineRunResponse;
    } catch (error) {
      throw new Error(`Failed to parse response from pipeline ${pipeline}. Error: ${error}`);
    }
  }

  /**
   * Perform a semantic search on a dataset.
   * 
   * @param query - The query string to search with.
   * @param datasetId - The ID of the dataset to search in.
   * @param limit - The maximum number of results to return.
   * @param threshold - The minimum score for the results to be returned.
   * @returns Response object containing the search results in descending order of relevance.
   */
  public static async semanticSearch({
    query,
    datasetId,
    limit,
    threshold,
  }: {
    query: string,
    datasetId: string,
    limit?: number,
    threshold?: number,
  }): Promise<SemanticSearchResponse> {
    const body = JSON.stringify({
      query,
      datasetId,
      limit,
      threshold,
    });

    const response = await fetch(`${this.baseHttpUrl}/v1/semantic-search`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to perform semantic search. Response: ${response.statusText}`);
    }

    return await response.json() as SemanticSearchResponse;
  }

  /**
   * Associates an event with the current span. If event with such name never
   * existed, Laminar will create a new event and infer its type from the value.
   * If the event already exists, Laminar will append the value to the event
   * if and only if the value is of a matching type. Otherwise, the event won't
   * be recorded. Supported types are string, number, and boolean. If the value
   * is `null`, event is considered a boolean tag with the value of `true`.
   *
   * @param name - The name of the event.
   * @param value - The value of the event. Must be a primitive type. If not
   * specified, boolean true is assumed in the backend.
   * @param timestamp - The timestamp of the event. If not specified, relies on
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
      console.warn("Laminar().event()\` called outside of span context." +
        ` Event '${name}' will not be recorded in the trace.` +
        " Make sure to annotate the function with a decorator"
      );
      return;
    }

    const event: Attributes = {
      "lmnr.event.type": "default",
    }
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
   * @param sessionId - The session ID to associate with the context.
   * @param fn - Function to execute within the session context.
   * @returns The result of the function execution.
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
   * @param attributes - The attributes to set for the current span.
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
    attributes: Record<typeof LaminarAttributes[keyof typeof LaminarAttributes], AttributeValue>
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
   * @param output - Output of the span. Will be sent as an attribute, so must be serializable to JSON.
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
   * @param name - name of the span
   * @param input - input to the span. Will be sent as an attribute, so must
   * be JSON serializable
   * @param span_type - type of the span. Defaults to 'DEFAULT'
   * @param context - raw OpenTelemetry context to bind the span to.
   * @param traceId - [EXPERIMENTAL] override the trace id for the span. If not
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
    traceId,
    labels,
  }: {
    name: string,
    input?: any,
    spanType?: 'LLM' | 'DEFAULT',
    context?: Context,
    traceId?: string,
    labels?: Record<string, string>,
  }): Span {
    let entityContext = context ?? contextApi.active();
    if (traceId) {
      if (isStringUUID(traceId)) {
        const spanContext = {
          traceId: uuidToOtelTraceId(traceId),
          spanId: new RandomIdGenerator().generateSpanId(),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
        };
        entityContext = trace.setSpanContext(entityContext, spanContext);
      } else {
        console.warn(`Invalid trace ID ${traceId}. Expected a UUID.`);
      }
    }
    const labelProperties = labels ? Object.entries(labels).reduce((acc, [key, value]) => {
      acc[`${ASSOCIATION_PROPERTIES}.label.${key}`] = value;
      return acc;
    }, {} as Record<string, string>) : {};
    const attributes = {
      [SPAN_TYPE]: spanType ?? 'DEFAULT',
      ...labelProperties,
    }
    const span = getTracer().startSpan(name, { attributes }, entityContext);
    if (traceId && isStringUUID(traceId)) {
      span.setAttribute(OVERRIDE_PARENT_SPAN, true);
    }
    if (input) {
      span.setAttribute(SPAN_INPUT, JSON.stringify(input));
    }
    return span;
  }

  /**
   * A utility wrapper around OpenTelemetry's `context.with()`. Useful for 
   * passing spans around in manual instrumentation:
   * 
   * @param span - Parent span to bind the execution to.
   * @param fn - Function to execute within the span context.
   * @param endOnExit - Whether to end the span after the function has
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

  public static async shutdown() {
    await forceFlush();
  }

  public static async initEvaluation<D, T, O>({
    groupName,
    name,
  }: {
    groupName?: string,
    name?: string,
  }): Promise<InitEvaluationResponse> {
    const body = JSON.stringify({
      groupName: groupName ?? null,
      name: name ?? null,
    });
    const response = await fetch(`${this.baseHttpUrl}/v1/evals`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to create evaluation ${name}. Response: ${response.statusText}`);
    }

    return await response.json() as InitEvaluationResponse;
  }

  public static async saveEvalDatapoints<D, T, O>(
    evalId: StringUUID,
    datapoints: EvaluationDatapoint<D, T, O>[],
    groupName?: string,
  ): Promise<void> {
    let body = '';
    try {
      const points = datapoints.map((point) => ({
        ...point,
        // only save the first 100 characters of data, target, and executorOutput
        // full output is in the trace.
        data: typeof point.data === 'string'
          ? point.data.slice(0, 100)
          : JSON.stringify(point.data).slice(0, 100),
        target: typeof point.target === 'string'
          ? point.target.slice(0, 100)
          : JSON.stringify(point.target).slice(0, 100),
        executorOutput: typeof point.executorOutput === 'string'
          ? point.executorOutput.slice(0, 100)
          : JSON.stringify(point.executorOutput).slice(0, 100),
      }))
      body = JSON.stringify({ points: datapoints, groupName });
    } catch (error) {
      throw new Error(`Failed to serialize evaluation data for ${evalId}. Error: ${error}`);
    }
    const response = await fetch(`${this.baseHttpUrl}/v1/evals/${evalId}/datapoints`, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to save evaluation datapoints. Response: [${response.status}] ${response.statusText}`);
    }
  }

  public static async getDatapoints<D, T>({
    datasetName,
    offset,
    limit,
  }: {
    datasetName: string,
    offset: number,
    limit: number,
  }): Promise<GetDatapointsResponse<D, T>> {
    const params = new URLSearchParams({
      name: datasetName,
      offset: offset.toString(),
      limit: limit.toString()
    });
    const response = await fetch(`${this.baseHttpUrl}/v1/datasets/datapoints?${params.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get datapoints for dataset ${datasetName}. Response: ${response.statusText}`);
    }

    return await response.json() as GetDatapointsResponse<D, T>;
  }

  private static getHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.projectApiKey}`,
    };
  };

  /**
   * Wraps a Playwright browser with session recordings.
   * If you are using Stagehand, you can use {@link Laminar.wrapStagehand} instead.
   * 
   * @param browser - The Playwright browser to wrap.
   * 
   * @example
   * import { Laminar } from '@lmnr-ai/lmnr';
   * import { chromium } from 'playwright';
   * 
   * Laminar.initialize();
   * 
   * const browser = await chromium.launch();
   * await Laminar.wrapPlaywrightBrowser(browser);
   * 
   * // Now you can use the browser with Playwright as usual
   */
  public static async wrapPlaywrightBrowser(browser: any) {
    return wrapPlaywrightBrowser(browser);
  }

  /**
   * Wraps a Playwright browser context with session recordings.
   * It is recommended to use {@link Laminar.wrapPlaywrightBrowser} instead,
   * only use this method if you need to wrap a specific context, but not the entire browser.
   * 
   * If you are using Stagehand, you can use {@link Laminar.wrapStagehand} instead.
   * @param context - The Playwright browser context to wrap.
   * 
   * @example
   * import { Laminar } from '@lmnr-ai/lmnr';
   * import { chromium } from 'playwright';
   * 
   * Laminar.initialize();
   * 
   * const browser = await chromium.launch();
   * const context = await browser.newContext();
   * await Laminar.wrapPlaywrightContext(context);
   * // Now you can use the context with Playwright as usual
   */
  public static async wrapPlaywrightContext(context: any) {
    return wrapPlaywrightContext(context);
  }

  /**
   * Wraps a Playwright page with session recordings.
   * It is recommended to use {@link Laminar.wrapPlaywrightBrowser} instead,
   * only use this method if you need to wrap a specific page, but not the entire browser.
   * 
   * If you are using Stagehand, you can use {@link Laminar.wrapStagehand} instead.
   * @param page - The Playwright page to wrap.
   * 
   * @example
   * import { Laminar } from '@lmnr-ai/lmnr';
   * import { chromium } from 'playwright';
   * 
   * Laminar.initialize();
   * 
   * const browser = await chromium.launch();
   * const page = await browser.newPage();
   * await Laminar.wrapPlaywrightPage(page);
   * // Now you can use the page with Playwright as usual
   */
  public static async wrapPlaywrightPage(page: any) {
    return wrapPlaywrightPage(page);
  }

  /**
   * Wraps a Stagehand page with session recordings.
   * For raw playwright, use {@link Laminar.wrapPlaywrightBrowser} instead.
   *
   * @param stagehand - The Stagehand instance to wrap.
   * 
   * @example
   * import { Stagehand } from "@browserbasehq/stagehand";
   * import { Laminar } from "@lmnr-ai/lmnr";
   * 
   * Laminar.initialize();
   * 
   * const stagehand = new Stagehand();
   * await stagehand.init();
   * await Laminar.wrapStagehand(stagehand);
   * // Now you can use the stagehand as usual
   */
  public static async wrapStagehand(stagehand: any) {
    await wrapPlaywrightContext(stagehand.context);
    await wrapPlaywrightPage(stagehand.page);
  }

  public static getHttpUrl(): string {
    return this.baseHttpUrl;
  }

  public static getProjectApiKey(): string {
    return this.projectApiKey;
  }
}
