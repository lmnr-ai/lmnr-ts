import { LaminarClient } from "@lmnr-ai/client";
import { type SessionRecordingOptions } from "@lmnr-ai/types";
import { diag, type Span, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { observe as laminarObserve } from "../../../decorators";
import { Laminar } from "../../../laminar";
import { TRACE_HAS_BROWSER_SESSION } from "../../../opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "../../../opentelemetry-lib/tracing/context";
import { newUUID, otelTraceIdToUUID, StringUUID } from "../../../utils";
import {
  modelToProvider,
  nameArgsOrCopy,
  prettyPrintZodSchema,
} from "../../utils";
import {
  createLLMClientCreateChatCompletionWrapper,
  GlobalLLMClientOptions,
} from "../shared-llm-wrapper";
import { injectRecorderViaCDP } from "./cdp-helpers";
import { logger } from "./constants";
import {
  createBindingHandler,
  createTargetCreatedHandler,
  createTargetInfoChangedHandler,
} from "./event-handlers";
import {
  StagehandV3Context,
  TargetCreatedEvent,
  TargetInfoChangedEvent,
  V3RecorderState,
} from "./types";

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-misused-promises
*/

/**
 * Guarded _wrap: only wraps `target[methodName]` if it exists as a function.
 * Prevents the "Cannot wrap non-existent method" warning from
 * InstrumentationBase._wrap when a handler/method was renamed or removed
 * in the upstream library (e.g. Stagehand v2 vs v3 differences).
 */
const safeWrap = (
  instrumentation: any,
  target: any,
  methodName: string,
  wrapper: (original: any) => any,
): boolean => {
  if (!target) return false;
  if (typeof target[methodName] !== "function") return false;
  instrumentation._wrap(target, methodName, wrapper);
  return true;
};

/**
 * Guarded _unwrap counterpart to safeWrap. Only unwraps when the target method
 * exists AND was previously wrapped via shimmer (has the `__original` marker).
 */
const safeUnwrap = (
  instrumentation: any,
  target: any,
  methodName: string,
): void => {
  if (!target) return;
  const current = target[methodName];
  if (typeof current !== "function") return;
  if (!current.__original) return;
  instrumentation._unwrap(target, methodName);
};

export class StagehandInstrumentation extends InstrumentationBase {
  private stagehandInstanceToSessionId: WeakMap<object, StringUUID> =
    new WeakMap();
  private globalLLMClientOptions: WeakMap<
    any,
    GlobalLLMClientOptions | undefined
  > = new WeakMap();
  private globalAgentOptions: WeakMap<object, Record<string, any> | undefined> =
    new WeakMap();
  private sessionIdToParentSpan: Map<StringUUID, Span> = new Map();

  // Session recording state per Stagehand instance
  private stagehandInstanceToRecorderState: WeakMap<object, V3RecorderState> =
    new WeakMap();

  // LaminarClient for sending events (set externally)
  private _client: LaminarClient | null = null;

  // Session recording options
  private _sessionRecordingOptions?: SessionRecordingOptions;

  constructor(sessionRecordingOptions?: SessionRecordingOptions) {
    super("@lmnr/browserbase-stagehand-instrumentation", SDK_VERSION, {
      enabled: true,
    });
    this._sessionRecordingOptions = sessionRecordingOptions;
  }

  /**
   * Set the LaminarClient to use for sending browser events.
   * This must be called before Stagehand.init() to enable session recording.
   */
  public setClient(client: LaminarClient): void {
    this._client = client;
  }

  /**
   * Get the LaminarClient instance
   */
  public get client(): LaminarClient | null {
    return this._client;
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@browserbasehq/stagehand",
      [">=3.0.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  private patch(moduleExports: any, moduleVersion?: string) {
    diag.debug(`patching stagehand ${moduleVersion}`);

    // Check if Stagehand is non-configurable
    const descriptor = Object.getOwnPropertyDescriptor(
      moduleExports,
      "Stagehand",
    );
    if (descriptor && !descriptor.configurable) {
      // Create a proxy for the entire module exports
      const originalStagehand = moduleExports.Stagehand;
      const patchedConstructor =
        this.patchStagehandConstructor()(originalStagehand);

      // Create a proxy for the module exports
      return new Proxy(moduleExports, {
        get: (target, prop) => {
          if (prop === "Stagehand") {
            return patchedConstructor;
          }
          return target[prop as keyof typeof target];
        },
      });
    } else {
      // If it's configurable, use the standard _wrap method
      this._wrap(moduleExports, "Stagehand", this.patchStagehandConstructor());

      return moduleExports;
    }
  }

  public manuallyInstrument(Stagehand: any) {
    diag.debug("manually instrumenting stagehand");

    // Patch the prototype methods of the existing constructor
    if (Stagehand && Stagehand.prototype) {
      this._wrap(Stagehand.prototype, "init", this.patchStagehandInit());
      this._wrap(Stagehand.prototype, "close", this.patchStagehandClose());
    }
  }

  private unpatch(moduleExports: any, moduleVersion?: string) {
    diag.debug(`unpatching stagehand ${moduleVersion}`);
    safeUnwrap(this, moduleExports, "Stagehand");

    if (moduleExports.Stagehand && moduleExports.Stagehand.prototype) {
      const prototype = moduleExports.Stagehand.prototype;
      safeUnwrap(this, prototype, "init");
      safeUnwrap(this, prototype, "close");
      safeUnwrap(this, prototype, "act");
      safeUnwrap(this, prototype, "extract");
      safeUnwrap(this, prototype, "observe");
      safeUnwrap(this, prototype, "agent");

      // Try to unwrap handler methods if they exist on the prototype
      if (prototype.actHandler) {
        safeUnwrap(this, prototype.actHandler, "act");
        safeUnwrap(this, prototype.actHandler, "actFromObserveResult");
      }
      if (prototype.extractHandler) {
        safeUnwrap(this, prototype.extractHandler, "extract");
      }
      if (prototype.observeHandler) {
        safeUnwrap(this, prototype.observeHandler, "observe");
      }
      // Try to unwrap LLM client if it exists
      if (prototype.llmClient) {
        safeUnwrap(this, prototype.llmClient, "createChatCompletion");
      }
      // Try to unwrap API client (BROWSERBASE remote mode) if it exists
      if (prototype.apiClient) {
        safeUnwrap(this, prototype.apiClient, "act");
        safeUnwrap(this, prototype.apiClient, "extract");
        safeUnwrap(this, prototype.apiClient, "observe");
        safeUnwrap(this, prototype.apiClient, "agentExecute");
      }
    }

    return moduleExports;
  }

  private patchStagehandConstructor() {
    const instrumentation = this;

    return (Original: any) => {
      // Create a constructor function that maintains the same signature
      const Stagehand = function (
        this: InstanceType<typeof Original>,
        ...args: any[]
      ) {
        // Only apply if this is a new instance
        if (!(this instanceof Stagehand)) {
          return new Stagehand(...args);
        }

        const instance = new Original(args.length > 0 ? args[0] : undefined);
        Object.assign(this, instance);

        instrumentation._wrap(
          this,
          "init",
          instrumentation.patchStagehandInit(),
        );

        instrumentation._wrap(
          this,
          "close",
          instrumentation.patchStagehandClose(),
        );

        return this;
      } as unknown as typeof Original;

      // Copy static properties
      Object.setPrototypeOf(Stagehand, Original);
      // Copy prototype properties
      Stagehand.prototype = Object.create(Original.prototype);
      Stagehand.prototype.constructor = Stagehand;

      return Stagehand;
    };
  }

  private patchStagehandInit() {
    const instrumentation = this;

    return (original: any) =>
      async function method(this: any) {
        const sessionId = newUUID();

        // Create parent span for this Stagehand session
        const parentSpan = Laminar.startSpan({
          name: "Stagehand",
        });
        instrumentation.sessionIdToParentSpan.set(sessionId, parentSpan);

        instrumentation.stagehandInstanceToSessionId.set(this, sessionId);

        // Get trace ID from current span context
        const currentSpan =
          trace.getSpan(LaminarContextManager.getContext()) ??
          trace.getActiveSpan();
        currentSpan?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
        const otelTraceId = parentSpan.spanContext().traceId;
        const traceId = otelTraceIdToUUID(otelTraceId);

        // Call the original init method first
        const result = await original.bind(this).apply(this);

        // After init, wrap the global methods on the stagehand instance
        safeWrap(
          instrumentation,
          this,
          "act",
          instrumentation.patchStagehandGlobalMethod(
            "act",
            sessionId,
            parentSpan,
          ),
        );

        safeWrap(
          instrumentation,
          this,
          "extract",
          instrumentation.patchStagehandGlobalMethod(
            "extract",
            sessionId,
            parentSpan,
          ),
        );

        safeWrap(
          instrumentation,
          this,
          "observe",
          instrumentation.patchStagehandGlobalMethod(
            "observe",
            sessionId,
            parentSpan,
          ),
        );

        // Wrap handler methods if they exist. In BROWSERBASE remote mode
        // (env: "BROWSERBASE" with server-side API enabled), Stagehand routes
        // act/extract/observe through `this.apiClient` instead of these local
        // handlers, so these handlers' methods may not be invoked — but we still
        // wrap them defensively for local/experimental modes.
        if (this.actHandler) {
          instrumentation.patchActHandler(this.actHandler);
        }

        if (this.extractHandler) {
          instrumentation.patchExtractHandler(this.extractHandler);
        }

        if (this.observeHandler) {
          instrumentation.patchObserveHandler(this.observeHandler);
        }

        // Wrap LLM client if it exists. Note: in BROWSERBASE remote mode the
        // LLM calls happen server-side on the Stagehand API, so this wrapper
        // never fires. Remote LLM spans are surfaced by wrapping `apiClient`
        // below instead.
        if (this.llmClient) {
          instrumentation.globalLLMClientOptions.set(this.llmClient, {
            provider: this.llmClient.type,
            model: this.llmClient.modelName,
          });
          safeWrap(
            instrumentation,
            this.llmClient,
            "createChatCompletion",
            instrumentation.patchStagehandLLMClientCreateChatCompletion(),
          );
        }

        // In BROWSERBASE remote mode Stagehand creates an internal
        // `apiClient` that performs act/extract/observe/agentExecute calls
        // on the Stagehand server. Wrap those methods so we still emit
        // stagehand.* spans (with LLM usage propagated where available)
        // even when the local handlers and local llmClient are bypassed.
        if (this.apiClient) {
          instrumentation.patchStagehandApiClient(
            this.apiClient,
            parentSpan,
            this,
          );
        }

        // Wrap agent method if it exists
        safeWrap(
          instrumentation,
          this,
          "agent",
          instrumentation.patchStagehandAgentInitializer(sessionId, parentSpan),
        );

        // Set up session recording if client is available
        if (instrumentation._client) {
          await instrumentation.setupSessionRecording(this, sessionId, traceId);
        }

        // Patch all existing pages
        if (this.context && this.context.pages) {
          for (const page of this.context.pages()) {
            instrumentation.patchStagehandPage(page, parentSpan);
          }
        }

        // Set up listener for new pages
        if (this.context && this.context.on) {
          this.context.on("page", (page: any) => {
            instrumentation.patchStagehandPage(page, parentSpan);
          });
        }

        return result;
      };
  }

  /**
   * Set up session recording for a Stagehand instance
   */
  private async setupSessionRecording(
    stagehandInstance: any,
    sessionId: StringUUID,
    traceId: StringUUID,
  ): Promise<void> {
    if (!this._client) {
      logger.debug(
        "No Laminar client available, skipping session recording setup",
      );
      return;
    }

    // Get the context from the Stagehand instance
    const context = stagehandInstance.context as StagehandV3Context | undefined;
    if (!context || !context.conn) {
      logger.debug(
        "No context or connection available, skipping session recording setup",
      );
      return;
    }
    // Create recorder state
    const recorderState: V3RecorderState = {
      sessionId,
      traceId,
      client: this._client,
      chunkBuffers: new Map(),
      contextIdToSession: new Map(),
      instrumentedPageIds: new Set(),
      bindingHandler: null,
      targetCreatedHandler: null,
      targetInfoChangedHandler: null,
      pageSessionHandlers: new Map(),
    };

    // Store recorder state
    this.stagehandInstanceToRecorderState.set(stagehandInstance, recorderState);

    // Set up binding event handler
    // (will be registered on individual page sessions during injection)
    const bindingHandler = createBindingHandler(recorderState);
    recorderState.bindingHandler = bindingHandler;

    // Set up target created handler for new pages
    const targetCreatedHandler = createTargetCreatedHandler(
      context,
      recorderState,
      this._sessionRecordingOptions,
    );
    recorderState.targetCreatedHandler = targetCreatedHandler;
    context.conn.on<TargetCreatedEvent>(
      "Target.targetCreated",
      targetCreatedHandler,
    );

    // Set up target info changed handler for re-injection after navigation
    const targetInfoChangedHandler = createTargetInfoChangedHandler(
      context,
      recorderState,
      this._sessionRecordingOptions,
    );
    recorderState.targetInfoChangedHandler = targetInfoChangedHandler;
    context.conn.on<TargetInfoChangedEvent>(
      "Target.targetInfoChanged",
      targetInfoChangedHandler,
    );

    // Inject recorder into all existing pages
    try {
      const pages = context.pages();
      let injectedCount = 0;
      for (const page of pages) {
        try {
          const result = await injectRecorderViaCDP(
            page,
            recorderState,
            context.conn,
            this._sessionRecordingOptions,
            bindingHandler,
          );
          if (result !== null) {
            injectedCount++;
          }
        } catch (error) {
          // Page might have been closed or CDP session lost, continue with next page
          logger.debug(
            "Error injecting recorder into page: " +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      logger.debug(
        `Injected session recorder into ${injectedCount} of ${pages.length} existing page(s)`,
      );
    } catch (error) {
      logger.debug(
        "Error accessing pages for recorder injection: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private patchStagehandClose() {
    const instrumentation = this;
    return (original: Function) =>
      async function method(this: any, ...args: any[]) {
        // Clean up session recording before closing
        instrumentation.cleanupSessionRecording(this);

        // Clean up the session from the registry
        const sessionId =
          instrumentation.stagehandInstanceToSessionId.get(this);
        if (sessionId) {
          instrumentation.stagehandInstanceToSessionId.delete(this);
        }

        await original.bind(this).apply(this, args);

        // Clean up the parent span from the registry
        if (sessionId) {
          const parentSpan =
            instrumentation.sessionIdToParentSpan.get(sessionId);
          if (parentSpan) {
            parentSpan.end();
            instrumentation.sessionIdToParentSpan.delete(sessionId);
          }
        }
      };
  }

  /**
   * Clean up session recording resources for a Stagehand instance
   */
  private cleanupSessionRecording(stagehandInstance: any): void {
    const recorderState =
      this.stagehandInstanceToRecorderState.get(stagehandInstance);
    if (!recorderState) return;

    // Get the context to remove event listeners
    const context = stagehandInstance.context as StagehandV3Context | undefined;
    if (context && context.conn) {
      // Remove target created handler
      if (recorderState.targetCreatedHandler) {
        try {
          context.conn.off(
            "Target.targetCreated",
            recorderState.targetCreatedHandler,
          );
        } catch (error) {
          logger.debug(
            "Error removing target created handler: " +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Remove target info changed handler
      if (recorderState.targetInfoChangedHandler) {
        try {
          context.conn.off(
            "Target.targetInfoChanged",
            recorderState.targetInfoChangedHandler,
          );
        } catch (error) {
          logger.debug(
            "Error removing target info changed handler: " +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Clear state
    recorderState.contextIdToSession.clear();
    recorderState.instrumentedPageIds.clear();
    recorderState.chunkBuffers.clear();
    recorderState.pageSessionHandlers.clear();
    recorderState.bindingHandler = null;
    recorderState.targetCreatedHandler = null;
    recorderState.targetInfoChangedHandler = null;

    // Remove from WeakMap
    this.stagehandInstanceToRecorderState.delete(stagehandInstance);

    logger.debug("Cleaned up session recording for Stagehand instance");
  }

  private patchStagehandGlobalMethod(
    methodName: string,
    sessionId: StringUUID,
    parentSpan: any,
  ) {
    return (original: (...args: any[]) => Promise<any>) =>
      async function method(this: any, ...args: any[]) {
        const input = nameArgsOrCopy(args);
        const currentSpan =
          trace.getSpan(LaminarContextManager.getContext()) ??
          trace.getActiveSpan();

        // Handle extract schema pretty-printing
        if (
          methodName === "extract" &&
          Array.isArray(input) &&
          input.length > 1 &&
          input[1]?.shape
        ) {
          // We need to clone the input object to avoid mutating the original object
          // because the original object is passed to the LLM client
          const schema = input[1];
          let prettySchema = schema?.shape;
          try {
            prettySchema = prettyPrintZodSchema(schema);
          } catch (error) {
            diag.warn("Error pretty printing zod schema", { error });
          }
          input[1] = prettySchema;
        }

        // Also handle extract when options contain schema
        if (
          methodName === "extract" &&
          Array.isArray(input) &&
          input.length > 0 &&
          typeof input[0] === "string" &&
          input.length > 1 &&
          input[1]?.shape
        ) {
          const schema = input[1];
          let prettySchema = schema?.shape;
          try {
            prettySchema = prettyPrintZodSchema(schema);
          } catch (error) {
            diag.warn("Error pretty printing zod schema", { error });
          }
          input[1] = prettySchema;
        }

        return await Laminar.withSpan(
          currentSpan ?? parentSpan,
          async () =>
            await laminarObserve(
              {
                name: `stagehand.${methodName}`,
                input,
              },
              async (thisArg: any, rest: any[]) => {
                const span =
                  trace.getSpan(LaminarContextManager.getContext()) ??
                  trace.getActiveSpan();
                span?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
                return await original.apply(thisArg, rest);
              },
              this,
              args,
            ),
        );
      };
  }

  private patchActHandler(actHandler: any) {
    // Patch the main act method on the handler (guarded because the
    // upstream handler shape may change across Stagehand versions).
    safeWrap(this, actHandler, "act", this.patchActHandlerAct());

    // Patch actFromObserveResult (v2 only; v3 moved this to
    // `takeDeterministicAction`, so guard to avoid wrapping non-existent methods)
    safeWrap(
      this,
      actHandler,
      "actFromObserveResult",
      this.patchActHandlerActFromObserveResult(),
    );
  }

  private patchActHandlerAct() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function act(this: any, ...args: any[]) {
        const params = args[0];
        return await laminarObserve(
          {
            name: "stagehand.actHandler.act",
            input: {
              instruction: params?.instruction,
              variables: params?.variables,
              timeout: params?.timeout,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchActHandlerActFromObserveResult() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function actFromObserveResult(this: any, ...args: any[]) {
        const action = args[0];
        const domSettleTimeoutMs = args[2];
        return await laminarObserve(
          {
            name: "stagehand.actHandler.actFromObserveResult",
            input: {
              action: action,
              domSettleTimeoutMs: domSettleTimeoutMs,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchExtractHandler(extractHandler: any) {
    // Patch the main extract method on the handler
    safeWrap(
      this,
      extractHandler,
      "extract",
      this.patchExtractHandlerExtract(),
    );
  }

  private patchExtractHandlerExtract() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function extract(this: any, ...args: any[]) {
        const params = args[0];
        const schema = params?.schema;
        let prettySchema = schema?.shape;

        if (schema) {
          try {
            prettySchema = prettyPrintZodSchema(schema);
          } catch (error) {
            diag.warn("Error pretty printing zod schema", { error });
          }
        }

        return await laminarObserve(
          {
            name: "stagehand.extractHandler.extract",
            input: {
              instruction: params?.instruction,
              schema: prettySchema,
              timeout: params?.timeout,
              selector: params?.selector,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchObserveHandler(observeHandler: any) {
    // Patch the main observe method on the handler
    safeWrap(
      this,
      observeHandler,
      "observe",
      this.patchObserveHandlerObserve(),
    );
  }

  private patchObserveHandlerObserve() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function observe(this: any, ...args: any[]) {
        const params = args[0];
        return await laminarObserve(
          {
            name: "stagehand.observeHandler.observe",
            input: {
              instruction: params?.instruction,
              timeout: params?.timeout,
              selector: params?.selector,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchStagehandLLMClientCreateChatCompletion() {
    return createLLMClientCreateChatCompletionWrapper(
      this.globalLLMClientOptions,
    );
  }

  private patchStagehandAgentInitializer(
    sessionId: StringUUID,
    parentSpan: Span,
  ) {
    const instrumentation = this;
    return (original: (...args: any[]) => any) =>
      function agent(this: any, ...args: any[]) {
        const agent = original.bind(this).apply(this, args);
        if (args.length > 0 && typeof args[0] === "object") {
          instrumentation.globalAgentOptions.set(agent, args[0]);
        }
        instrumentation.patchStagehandAgent(agent, sessionId, parentSpan);
        return agent;
      };
  }

  private patchStagehandAgent(
    agent: any,
    sessionId: StringUUID,
    parentSpan: Span,
  ) {
    safeWrap(
      this,
      agent,
      "execute",
      this.patchStagehandAgentExecute(sessionId, parentSpan),
    );

    // Wrap additional agent methods (already no-ops when the method is missing
    // via wrapAgentMethod's own guard)
    this.wrapAgentMethod(agent, "captureScreenshot", parentSpan, {
      spanType: "TOOL",
      ignoreOutput: true,
    });
    this.wrapAgentMethod(agent, "setViewport", parentSpan);
    this.wrapAgentMethod(agent, "setCurrentUrl", parentSpan);
  }

  private patchStagehandAgentExecute(sessionId: StringUUID, parentSpan: Span) {
    const instrumentation = this;
    return (original: (this: any, ...args: any[]) => Promise<any>) =>
      async function execute(this: any, ...args: any[]) {
        const input = nameArgsOrCopy(args);

        return await Laminar.withSpan(
          parentSpan,
          async () =>
            await laminarObserve(
              {
                name: "stagehand.agent.execute",
                input,
              },
              async () =>
                await laminarObserve(
                  {
                    name: "execute",
                    // input and output are set as gen_ai.prompt and gen_ai.completion
                    ignoreInput: true,
                    ignoreOutput: true,
                    spanType: "LLM",
                  },
                  async () => {
                    const span =
                      trace.getSpan(LaminarContextManager.getContext()) ??
                      trace.getActiveSpan();
                    span?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);

                    const agentOptions =
                      instrumentation.globalAgentOptions.get(this);
                    const maybeModelName: string | undefined =
                      agentOptions?.model?.modelName ??
                      (typeof agentOptions?.model === "string"
                        ? agentOptions.model
                        : undefined);
                    const provider =
                      agentOptions?.model?.provider ??
                      (maybeModelName?.includes("/")
                        ? maybeModelName?.split("/")[0]
                        : instrumentation.globalLLMClientOptions.get(this)
                          ?.provider);
                    const model =
                      maybeModelName ??
                      instrumentation.globalLLMClientOptions.get(this)?.model;
                    span?.setAttributes({
                      ...(provider ? { "gen_ai.system": provider } : {}),
                      ...(model ? { "gen_ai.request.model": model } : {}),
                    });

                    let promptIndex = 0;
                    if (agentOptions?.systemPrompt) {
                      span?.setAttributes({
                        "gen_ai.prompt.0.content": agentOptions.systemPrompt,
                        "gen_ai.prompt.0.role": "system",
                      });
                      promptIndex++;
                    }

                    const instruction =
                      typeof input === "string"
                        ? input
                        : (input as any).instruction;
                    if (instruction) {
                      span?.setAttributes({
                        [`gen_ai.prompt.${promptIndex}.content`]: instruction,
                        [`gen_ai.prompt.${promptIndex}.role`]: "user",
                      });
                    }

                    const result = await original.bind(this).apply(this, args);

                    if (result.completed && result.success && result.message) {
                      const content = [{ type: "text", text: result.message }];
                      if (result.actions && result.actions.length > 0) {
                        content.push({
                          type: "text",
                          text: JSON.stringify({ actions: result.actions }),
                        });
                      }
                      span?.setAttributes({
                        "gen_ai.completion.0.content": JSON.stringify(content),
                        "gen_ai.completion.0.role": "assistant",
                      });
                    } else if (result.completed && !result.success) {
                      span?.recordException(new Error(result.message));
                    }
                    if (result.usage) {
                      span?.setAttributes({
                        "gen_ai.usage.input_tokens": result.usage.input_tokens,
                        "gen_ai.usage.output_tokens":
                          result.usage.output_tokens,
                        "llm.usage.total_tokens":
                          result.usage.input_tokens +
                          result.usage.output_tokens,
                      });
                    }
                    return result;
                  },
                ),
            ),
        );
      };
  }

  private wrapAgentMethod(
    agent: any,
    methodName: string,
    parentSpan: Span,
    options?: {
      spanType?:
        | "TOOL"
        | "LLM"
        | "DEFAULT"
        | "EVALUATOR"
        | "EVALUATION"
        | "EXECUTOR";
      ignoreOutput?: boolean;
    },
  ) {
    safeWrap(
      this,
      agent,
      methodName,
      (original: (...args: any[]) => Promise<any>) =>
        async function method(this: any, ...args: any[]) {
          const currentSpan =
            trace.getSpan(LaminarContextManager.getContext()) ??
            trace.getActiveSpan();
          return await Laminar.withSpan(
            currentSpan ?? parentSpan,
            async () =>
              await laminarObserve(
                {
                  name: `stagehand.agent.${methodName}`,
                  ...(options?.spanType ? { spanType: options.spanType } : {}),
                  ...(options?.ignoreOutput ? { ignoreOutput: true } : {}),
                },
                async (argVals: any[]) =>
                  await original.bind(this).apply(this, argVals),
                args,
              ),
          );
        },
    );
  }

  private patchStagehandPage(page: any, parentSpan: Span) {
    const pageMethods = [
      "goto",
      "reload",
      "goBack",
      "goForward",
      "click",
      "scroll",
      "dragAndDrop",
      "type",
      "keyPress",
      "keyDown",
      "keyUp",
    ];

    for (const methodName of pageMethods) {
      safeWrap(
        this,
        page,
        methodName,
        (original: (...args: any[]) => Promise<any>) =>
          async function method(this: any, ...args: any[]) {
            const currentSpan =
              trace.getSpan(LaminarContextManager.getContext()) ??
              trace.getActiveSpan();
            return await Laminar.withSpan(
              currentSpan ?? parentSpan,
              async () =>
                await laminarObserve(
                  {
                    name: `stagehand.page.${methodName}`,
                  },
                  async (argVals: any[]) =>
                    await original.bind(this).apply(this, argVals),
                  args,
                ),
            );
          },
      );
    }
  }

  /**
   * In BROWSERBASE remote mode Stagehand's top-level `act`/`extract`/`observe`/
   * agent `execute` are routed through an internal `StagehandAPIClient` which
   * makes HTTP calls to the Stagehand Cloud API. The local `llmClient` and the
   * local `actHandler`/`extractHandler`/`observeHandler` are therefore never
   * invoked and our existing wrappers do not fire.
   *
   * Wrap the apiClient methods directly so we still emit child spans for the
   * LLM-backed calls and surface token usage from the response where available.
   */
  private patchStagehandApiClient(
    apiClient: any,
    parentSpan: Span,
    stagehandInstance: any,
  ) {
    const instrumentation = this;

    let baseProvider = stagehandInstance?.llmClient?.type as string | undefined;
    const baseModel = stagehandInstance?.llmClient?.modelName as
      | string
      | undefined;

    if (baseModel && !baseProvider) {
      baseProvider = modelToProvider(baseModel) ?? "aisdk";
    }

    const wrapApiMethod = (methodName: "act" | "extract" | "observe") => {
      safeWrap(
        instrumentation,
        apiClient,
        methodName,
        (original: (...args: any[]) => Promise<any>) =>
          async function method(this: any, ...args: any[]) {
            const currentSpan =
              trace.getSpan(LaminarContextManager.getContext()) ??
              trace.getActiveSpan();

            const input = nameArgsOrCopy(args);

            const spanName = `stagehand.apiClient.${methodName}`;

            return await Laminar.withSpan(
              currentSpan ?? parentSpan,
              async () =>
                await laminarObserve(
                  {
                    name: spanName,
                    input,
                    spanType: "LLM",
                    ignoreInput: true,
                    ignoreOutput: true,
                  },
                  async () => {
                    const span =
                      trace.getSpan(LaminarContextManager.getContext()) ??
                      trace.getActiveSpan();
                    span?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);

                    // Best-effort provider/model attribution. Stagehand's
                    // remote API does not echo these back in the SSE stream,
                    // so fall back to the model configured on the instance.
                    if (baseProvider) {
                      span?.setAttribute("gen_ai.system", baseProvider);
                    }
                    if (baseModel) {
                      span?.setAttribute("gen_ai.request.model", baseModel);
                    }

                    // Capture the user-facing instruction as the LLM prompt
                    // when available so traces are not empty.
                    try {
                      const firstArg = args[0];
                      const instruction =
                        typeof firstArg === "string"
                          ? firstArg
                          : (firstArg?.input ?? firstArg?.instruction);
                      if (
                        typeof instruction === "string" &&
                        instruction.length > 0
                      ) {
                        span?.setAttributes({
                          "gen_ai.prompt.0.role": "user",
                          "gen_ai.prompt.0.content": instruction,
                        });
                      }
                    } catch {
                      // best-effort; do not break the call if attribute extraction fails
                    }

                    const result = await original.bind(this).apply(this, args);

                    try {
                      const usage = result?.usage;
                      if (usage) {
                        const inputTokens =
                          usage.input_tokens ?? usage.prompt_tokens ?? 0;
                        const outputTokens =
                          usage.output_tokens ?? usage.completion_tokens ?? 0;
                        span?.setAttributes({
                          "gen_ai.usage.input_tokens": inputTokens,
                          "gen_ai.usage.output_tokens": outputTokens,
                          "llm.usage.total_tokens": inputTokens + outputTokens,
                        });
                      }
                      span?.setAttribute(
                        "gen_ai.output.messages",
                        JSON.stringify([
                          {
                            role: "assistant",
                            content: result,
                          },
                        ]),
                      );
                    } catch {
                      // best-effort
                    }

                    return result;
                  },
                ),
            );
          },
      );
    };

    // There's no agentExecute here, as the local wrapper
    // adds sufficient information onto the resulting spans
    wrapApiMethod("act");
    wrapApiMethod("extract");
    wrapApiMethod("observe");
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-misused-promises
*/
