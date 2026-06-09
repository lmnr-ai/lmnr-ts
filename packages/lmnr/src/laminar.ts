import { spawn } from "node:child_process";

import { LaminarClient } from "@lmnr-ai/client";
import {
  errorMessage,
  type LaminarSpanContext,
  type SessionRecordingOptions,
  type SpanType,
  type TraceType,
  TracingLevel,
} from "@lmnr-ai/types";
import {
  AttributeValue,
  Context,
  context as contextApi,
  isSpanContextValid,
  type Span,
  TimeInput,
  trace,
} from "@opentelemetry/api";
import { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  getRuntime,
  initDebugRuntime,
  initDebugRuntimeFromContext,
  isTruthy,
  resetDebugRuntime,
} from "./debug";
import {
  InitializeOptions,
  initializeTracing,
  LaminarSpanProcessor,
} from "./opentelemetry-lib";
import { _resetConfiguration } from "./opentelemetry-lib/configuration";
import {
  forceReleaseProxy as forceReleaseClaudeProxy,
  instrumentClaudeAgentQuery,
} from "./opentelemetry-lib/instrumentation/claude-agent-sdk";
import {
  forceFlush,
  getSpanProcessor,
  getTracer,
  patchModules,
} from "./opentelemetry-lib/tracing";
import {
  ASSOCIATION_PROPERTIES,
  LaminarAttributes,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_TYPE,
  TRACE_TYPE,
  USER_ID,
} from "./opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "./opentelemetry-lib/tracing/context";
import { LaminarSpan } from "./opentelemetry-lib/tracing/span";
import {
  deserializeLaminarSpanContext,
  getFrontendUrl,
  initializeLogger,
  loadEnv,
  metadataToAttributes,
  otelTraceIdToUUID,
  type StringUUID,
  tryToOtelSpanContext,
  validateTracingConfig,
} from "./utils";

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
  (typeof LaminarAttributes)[keyof typeof LaminarAttributes],
  AttributeValue
>;

export class Laminar {
  private static baseHttpUrl: string;
  private static projectApiKey: string;
  private static isInitialized: boolean = false;
  private static globalMetadata: Record<string, any> = {};
  // The debug run's `exit` pointer hook, kept by reference so shutdown() can
  // remove it. `process.once` only auto-detaches after `exit` fires, so without
  // this an initialize()/shutdown() loop (common in tests) would accumulate
  // stale listeners and trip Node's MaxListenersExceededWarning.
  private static debugExitHook: (() => void) | null = null;
  // Base url / http port captured at initialize(), reused to build the client
  // when the debug runtime is armed late from a propagated context (the
  // from-context path has no access to initialize()'s args).
  private static baseUrlForDebug: string | undefined = undefined;
  private static httpPortForDebug: number | undefined = undefined;
  /**
   * Process-wide latch for debug-replay v2: once any LLM call gets a cache MISS,
   * every subsequent call runs live (skipping the cache lookup) for the rest of
   * the process. A COLD/`live` outcome runs that single call live WITHOUT
   * setting this flag. Read by the AI SDK wrapper's caching path; reset in
   * {@link shutdown} so an init/shutdown loop (tests) starts clean.
   */
  public static debugRunLive: boolean = false;
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
      logger.warn(
        "Laminar has already been initialized. Skipping initialization.",
      );
      return;
    }
    const key = projectApiKey ?? process?.env?.LMNR_PROJECT_API_KEY;

    // Validate that either API key or OTEL configuration is present
    validateTracingConfig(key);

    this.projectApiKey = key ?? "";
    let url = baseUrl ?? process?.env?.LMNR_BASE_URL;

    // Only set default URL if we have an API key (traditional Laminar setup)
    if (key && !url) {
      url = "https://api.lmnr.ai";
    }

    const httpUrl = baseHttpUrl ?? url;
    let port: number | undefined = httpPort;

    if (httpUrl) {
      if (!port) {
        const m = httpUrl.match(/:\d{1,5}$/g);
        port = m ? parseInt(m[0].slice(1)) : 443;
      }
      const httpUrlWithoutSlash = httpUrl
        .replace(/\/$/, "")
        .replace(/:\d{1,5}$/g, "");
      this.baseHttpUrl = `${httpUrlWithoutSlash}:${port}`;
    } else {
      this.baseHttpUrl = "";
    }

    const envMetadata = process.env.LMNR_TRACE_METADATA
      ? (JSON.parse(process.env.LMNR_TRACE_METADATA) as Record<string, unknown>)
      : {};
    this.globalMetadata = { ...envMetadata, ...(metadata ?? {}) };
    if (inheritGlobalContext) {
      LaminarContextManager.inheritGlobalContext = true;
    }
    if (spanProcessor && !(spanProcessor instanceof LaminarSpanProcessor)) {
      logger.warn(
        "Span processor is not a LaminarSpanProcessor. Some functionality may be impaired.",
      );
    }
    this.isInitialized = true;

    const urlWithoutSlash = url?.replace(/\/$/, "").replace(/:\d{1,5}$/g, "");
    const httpUrlWithoutSlash = httpUrl
      ?.replace(/\/$/, "")
      .replace(/:\d{1,5}$/g, "");

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

    // Build the debug runtime only after tracing is up. It has no dependency on
    // initializeTracing (which never reads the runtime or global metadata), so
    // running it here means a tracing-init failure aborts before any debug side
    // effects — backend session registration, the `rollout.session_id` stamp,
    // the process-exit pointer hook — instead of leaving them live on a process
    // whose tracing never came up. It must still precede setGlobalMetadata (so
    // `rollout.session_id` is stamped on every span) and _initializeContextFromEnv
    // (so the runtime is registered before the inherited trace id is recorded).
    this._initDebugRuntime(url, port);
    LaminarContextManager.setGlobalMetadata(this.globalMetadata);

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
      if (
        processor &&
        processor instanceof LaminarSpanProcessor &&
        laminarContext.spanPath &&
        laminarContext.spanIdsPath
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
      const ctx = LaminarContextManager.setRawAssociationProperties(
        laminarContext,
        baseContext,
      );
      LaminarContextManager.pushContext(ctx);

      // On a debug run attached via LMNR_SPAN_CONTEXT, no span has a null parent
      // (everything descends from the injected context), so the processor's
      // root-span hook never fires. Record the inherited trace id here so the
      // run pointer (§5) isn't emitted with an empty trace_id.
      try {
        getRuntime()?.recordTraceId(otelTraceIdToUUID(otelSpanContext.traceId));
      } catch (e) {
        logger.debug(
          "Failed to record debug trace id from env: " + errorMessage(e),
        );
      }

      logger.debug(
        "Initialized Laminar parent context from LMNR_SPAN_CONTEXT.",
      );
    } catch (e) {
      logger.warn(
        "LMNR_SPAN_CONTEXT is set but could not be used: " + errorMessage(e),
      );
    }
  }

  /**
   * Build the in-process debug runtime (§4, §5) when LMNR_DEBUG is set.
   *
   * On a debug run the session id from the config is stamped into the global
   * trace metadata as `rollout.session_id`, and a process-exit hook emits the
   * run pointer once the root trace id is known. When debug mode is off this is
   * a no-op and the SDK behaves exactly as before.
   * @private
   */
  private static _initDebugRuntime(
    baseUrl: string | undefined,
    httpPort: number | undefined,
  ): void {
    // Capture the connection args so a later context-armed runtime (built deep
    // in span creation, with no access to initialize()'s args) can construct
    // its own client. Set unconditionally — even when local debug is off, a
    // downstream span may arrive carrying a debug block.
    this.baseUrlForDebug = baseUrl;
    this.httpPortForDebug = httpPort;

    try {
      // Bail before allocating a client on the common (non-debug) path. The
      // LMNR_DEBUG gate also lives inside buildDebugConfig (called by
      // initDebugRuntime), but that runs only after the client and debugger URL
      // are built — so check it up front to avoid the wasted allocation on
      // every initialize(). Mirrors Python's _is_truthy guard in
      // _init_debug_runtime.
      if (!isTruthy(process.env.LMNR_DEBUG)) {
        return;
      }
      const client = new LaminarClient({
        baseUrl,
        projectApiKey: this.projectApiKey,
        port: httpPort,
      });
      const debuggerUrl =
        process?.env?.LMNR_FRONTEND_URL ?? getFrontendUrl(baseUrl);
      const { runtime } = initDebugRuntime(client.rolloutSessions, debuggerUrl);
      if (runtime === null) {
        return;
      }

      // Register the session with the backend so it shows up in the UI. The
      // SDK owns the session id; this idempotent upsert is what makes a bare
      // `LMNR_DEBUG=true` run (no replay) useful. Best-effort and fire-and-
      // forget — initialize() is synchronous and registration must never block
      // or crash it. The backend returns the project id (derived from the API
      // key) so we can print the human-facing session URL.
      void client.rolloutSessions
        .register({ sessionId: runtime.sessionId })
        .then((projectId) => {
          if (projectId) {
            // Record the project id so the run pointer's debugger_url field
            // carries the SAME full per-session URL we print here (single code
            // path via debuggerSessionUrl).
            runtime.recordProjectId(projectId);
            const sessionUrl = runtime.debuggerSessionUrl()!;
            logger.info(`Laminar debugger session: ${sessionUrl}`);
            if (runtime.shouldOpenBrowser) {
              // only open URL in browser on first run when we minted a fresh
              // session id ourselves. A reused session id (passed explicitly via
              // LMNR_DEBUG_SESSION_ID or seeded from the prior run's pointer via
              // LMNR_DEBUG_FROM_LAST_RUN) is a replay/continuation, and a
              // context-armed downstream run is not the origin — neither reopens
              // the browser. The decision now reads the resolved config
              // (runtime.shouldOpenBrowser) rather than re-reading env vars.
              const opener =
                process.platform === "win32"
                  ? "start"
                  : process.platform === "darwin"
                    ? "open"
                    : "xdg-open";
              spawn(opener, [sessionUrl], {
                detached: true,
                stdio: "ignore",
              }).unref();
            }
          }
        })
        .catch((e) => {
          logger.warn("Failed to register debug session: " + errorMessage(e));
        });

      this.globalMetadata = {
        ...this.globalMetadata,
        "rollout.session_id": runtime.sessionId,
      };
      // `exit` fires on both natural event-loop drain and explicit
      // process.exit(), and emitPointer is synchronous, so a single `exit`
      // hook covers process teardown. Do NOT also hook `beforeExit`: it fires
      // on any transient event-loop idle, which can happen before the run's
      // root trace id is recorded — emitPointer is one-shot, so a premature
      // call would permanently spend the pointer with an empty trace_id.
      // Mirrors Python's single atexit hook. Drop any prior hook first so a
      // repeated initialize() (or an init/shutdown loop) doesn't pile up
      // listeners; keep this one by reference for shutdown() to remove.
      if (this.debugExitHook !== null) {
        process.removeListener("exit", this.debugExitHook);
      }
      this.debugExitHook = () => runtime.emitPointer();
      process.once("exit", this.debugExitHook);
    } catch (e) {
      // never let debug setup crash initialization
      logger.warn("Failed to initialize debug runtime: " + errorMessage(e));
    }
  }

  /**
   * Arm the debug runtime from a propagated `DebugContext`, if not already armed.
   *
   * Called from `_startSpan` (the single funnel all spans pass through) when a
   * parent `LaminarSpanContext` carrying an armed debug block first parses — so
   * a downstream service joins the upstream debug run regardless of how its
   * spans originate (auto-instrumentation, manual observe, external library).
   *
   * First-wins and idempotent: if a runtime already exists (from env at init,
   * or an earlier qualifying context) this returns immediately, so env-var
   * config keeps precedence over context. A downstream runtime reuses the
   * upstream session and may consult the cache, but — unlike the local-origin
   * path — does NOT open the browser, print the session URL, or register an
   * exit-time pointer hook (the origin owns those). It still registers the
   * session (idempotent) and stamps `rollout.session_id`.
   *
   * Never throws: any failure leaves debug inert.
   * @private
   */
  private static _armDebugRuntimeFromContext(
    debug: LaminarSpanContext["debug"],
  ): void {
    try {
      // Fast path: already armed (env or a prior context), or no armed block.
      // Bail before any allocation so this stays cheap on the hot span path.
      if (getRuntime() !== null) {
        return;
      }
      if (!debug || !debug.enabled || !debug.sessionId) {
        return;
      }

      const client = new LaminarClient({
        baseUrl: this.baseUrlForDebug,
        projectApiKey: this.projectApiKey,
        port: this.httpPortForDebug,
      });
      const debuggerUrl =
        process?.env?.LMNR_FRONTEND_URL ?? getFrontendUrl(this.baseUrlForDebug);
      const { runtime } = initDebugRuntimeFromContext(
        debug,
        client.rolloutSessions,
        debuggerUrl,
      );
      if (runtime === null) {
        return;
      }

      // Register the (upstream) session so downstream cache lookups are
      // accepted. Idempotent upsert, fire-and-forget. Unlike the local-origin
      // path we do NOT log the URL or open a browser — the origin already did.
      void client.rolloutSessions
        .register({ sessionId: runtime.sessionId })
        .then((projectId) => {
          if (projectId) {
            runtime.recordProjectId(projectId);
          }
        })
        .catch((e) => {
          logger.debug(
            "Failed to register downstream debug session: " + errorMessage(e),
          );
        });

      this.globalMetadata = {
        ...this.globalMetadata,
        "rollout.session_id": runtime.sessionId,
      };
      // Unlike the local-origin path (synced by initialize() at startup), this
      // runs during span creation, so re-sync to LaminarContextManager here or
      // LaminarSpanProcessor.onStart misses rollout.session_id on auto spans.
      LaminarContextManager.setGlobalMetadata(this.globalMetadata);
      // No `exit` pointer hook: a downstream run must not emit the pointer.
    } catch (e) {
      // never let debug arming crash span creation
      logger.debug("Failed to arm debug runtime from context: " + errorMessage(e));
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
      logger.warn(
        "Laminar must be initialized before patching modules. Skipping patch.",
      );
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
    name: string;
    attributes?: Record<string, AttributeValue>;
    timestamp?: TimeInput;
    sessionId?: string;
    userId?: string;
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

  public static getCurrentSpan(context?: Context): LaminarSpan | undefined {
    const currentSpan =
      trace.getSpan(context ?? LaminarContextManager.getContext()) ??
      trace.getActiveSpan();
    if (
      currentSpan === undefined ||
      !isSpanContextValid(currentSpan.spanContext())
    ) {
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
  public static setSpanAttributes(attributes: LaminarAttributesProp) {
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
      currentSpan.setOutput(output);
    }
  }

  public static setTraceMetadata(metadata: Record<string, any>) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      currentSpan.setTraceMetadata(metadata);
    }
  }

  public static setTraceSessionId(sessionId: string) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      currentSpan.setTraceSessionId(sessionId);
    }
  }

  public static setTraceUserId(userId: string) {
    const currentSpan = Laminar.getCurrentSpan();
    if (currentSpan) {
      currentSpan.setTraceUserId(userId);
    }
  }

  public static setSpanTags(tags: string[]) {
    const currentSpan = Laminar.getCurrentSpan();
    if (
      currentSpan !== undefined &&
      isSpanContextValid(currentSpan.spanContext())
    ) {
      currentSpan.setTags(tags);
    }
  }

  public static addSpanTags(tags: string[]) {
    const currentSpan = Laminar.getCurrentSpan();
    if (
      currentSpan !== undefined &&
      isSpanContextValid(currentSpan.spanContext())
    ) {
      currentSpan.addTags(tags);
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
    name: string;
    input?: any;
    spanType?: SpanType;
    context?: Context;
    parentSpanContext?: string | LaminarSpanContext;
    tags?: string[];
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, any>;
    startTime?: TimeInput;
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
   * @param {boolean} options.global - when true, the span is registered on a
   * process-global context stack so that any subsequent `startSpan` /
   * `startActiveSpan` call (including from unrelated async tasks) uses it as
   * the parent. Use this for spans that span multiple disconnected async
   * callbacks — e.g. the root span of an OpenAI Agents trace, where child
   * spans are created from independent `TracingProcessor` callbacks that do
   * not share an async context. Defaults to false; the span still activates
   * within the current async context as usual.
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
    global,
  }: {
    name: string;
    input?: any;
    spanType?: SpanType;
    context?: Context;
    parentSpanContext?: string | LaminarSpanContext;
    tags?: string[];
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, any>;
    startTime?: TimeInput;
    global?: boolean;
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
      global,
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
    global,
  }: {
    name: string;
    input?: any;
    spanType?: SpanType;
    context?: Context;
    parentSpanContext?: string | LaminarSpanContext;
    tags?: string[];
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, any>;
    activated?: boolean;
    startTime?: TimeInput;
    global?: boolean;
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
        const laminarContext =
          typeof parentSpanContext === "string"
            ? deserializeLaminarSpanContext(parentSpanContext)
            : parentSpanContext;

        parentPath = laminarContext.spanPath;
        parentIdsPath = laminarContext.spanIdsPath;
        parentMetadata = laminarContext.metadata;
        parentTraceType = laminarContext.traceType;
        parentTracingLevel = laminarContext.tracingLevel;
        parentUserId = laminarContext.userId;
        parentSessionId = laminarContext.sessionId;

        // Arm the debug runtime from a propagated debug block (first-wins,
        // idempotent, no-op when already armed or no block present). Placed
        // here — deep in span creation, before any caching instrumentation
        // consults the runtime — so a downstream run joins the upstream debug
        // session regardless of how its spans originate.
        this._armDebugRuntimeFromContext(laminarContext.debug);

        const spanContext = tryToOtelSpanContext(laminarContext);
        entityContext = trace.setSpan(
          entityContext,
          trace.wrapSpanContext(spanContext),
        );
      } catch (e) {
        logger.warn("Failed to parse parent span context: " + errorMessage(e));
      }
    }
    const tagProperties = tags
      ? { [`${ASSOCIATION_PROPERTIES}.tags`]: Array.from(new Set(tags)) }
      : {};
    const ctxAssociationProperties =
      LaminarContextManager.getAssociationProperties();
    const userIdValue =
      userId ?? parentUserId ?? ctxAssociationProperties.userId;
    const sessionIdValue =
      sessionId ?? parentSessionId ?? ctxAssociationProperties.sessionId;
    const traceTypeValue =
      parentTraceType ??
      ((spanType as string) === "EVALUATION" ? "EVALUATION" : undefined) ??
      ctxAssociationProperties.traceType;
    const tracingLevelValue =
      parentTracingLevel ?? ctxAssociationProperties.tracingLevel;
    const ctxMetadata = ctxAssociationProperties.metadata;

    const userIdProperties = userIdValue ? { [USER_ID]: userIdValue } : {};
    const sessionIdProperties = sessionIdValue
      ? { [SESSION_ID]: sessionIdValue }
      : {};
    const traceTypeProperties = traceTypeValue
      ? { [TRACE_TYPE]: traceTypeValue }
      : {};
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
      [SPAN_TYPE]: spanType ?? "DEFAULT",
      ...tagProperties,
      ...userIdProperties,
      ...sessionIdProperties,
      ...metadataProperties,
      ...traceTypeProperties,
      ...tracingLevelProperties,
      ...(parentPath ? { [PARENT_SPAN_PATH]: parentPath } : {}),
      ...(parentIdsPath ? { [PARENT_SPAN_IDS_PATH]: parentIdsPath } : {}),
    };

    const span = new LaminarSpan(
      getTracer().startSpan(name, { attributes, startTime }, entityContext),
    );
    span.activated = activated ?? false;

    if (input) {
      span.setInput(input);
    }
    if (activated) {
      entityContext = LaminarContextManager.setAssociationProperties(
        span,
        entityContext,
      );
      entityContext = trace.setSpan(entityContext, span);
      LaminarContextManager.pushContext(entityContext);
      if (global) {
        LaminarContextManager.pushGlobalContext(entityContext);
        span.setGlobalActiveContext(entityContext);
      }
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
    const ctxWithAssociationProperties =
      LaminarContextManager.setAssociationProperties(laminarSpan, ctx);
    const context = trace.setSpan(ctxWithAssociationProperties, span);
    return contextApi.with(context, () =>
      LaminarContextManager.runWithIsolatedContext([context], () => {
        try {
          const result = fn();
          if (result instanceof Promise) {
            return result
              .catch((err) => {
                span.recordException(err as Error);
                throw err;
              })
              .finally(() => {
                if (endOnExit !== undefined && endOnExit) {
                  span.end();
                }
              }) as T;
          }
          if (endOnExit !== undefined && endOnExit) {
            span.end();
          }
          return result;
        } catch (error) {
          span.recordException(error as Error);
          if (endOnExit !== undefined && endOnExit) {
            span.end();
          }
          throw error;
        }
      }),
    );
  }

  public static serializeLaminarSpanContext(span?: Span): string | null {
    const laminarSpanContext = this.getLaminarSpanContext(span);
    if (laminarSpanContext === null) {
      return null;
    }
    return JSON.stringify(laminarSpanContext);
  }

  public static getLaminarSpanContext(span?: Span): LaminarSpanContext | null {
    let currentSpan = span ?? Laminar.getCurrentSpan();
    if (
      currentSpan === undefined ||
      !isSpanContextValid(currentSpan.spanContext())
    ) {
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
      // Emit the debug run pointer before flushing so flows that shut down
      // without terminating the process still get LMNR_DEBUG_RUN +
      // .lmnr/last-run.json. Idempotent — the process-exit hooks are a fallback.
      getRuntime()?.emitPointer();
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
      // Clear the one-shot debug-runtime state so a subsequent initialize()
      // re-reads LMNR_DEBUG* instead of resurrecting the previous run.
      resetDebugRuntime();
      // Clear the process-wide live latch so a re-initialized run starts by
      // consulting the cache again instead of inheriting the prior run's MISS.
      this.debugRunLive = false;
      // The pointer was just emitted above, so the `exit` hook would be a
      // redundant no-op; remove it so init/shutdown loops don't leak listeners.
      if (this.debugExitHook !== null) {
        process.removeListener("exit", this.debugExitHook);
        this.debugExitHook = null;
      }

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return instrumentClaudeAgentQuery(originalQuery as any);
  }
}
