import { AsyncLocalStorage } from "node:async_hooks";

import { Context, context, diag } from "@opentelemetry/api";
import { isTracingSuppressed, suppressTracing } from "@opentelemetry/core";

import { initializeLogger } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import {
  InstrumentedFile,
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
} from "../shared/base";
import { HANDLER_NAME, LaminarCallbackHandler } from "./callback-handler";
import { LLM_CALL_KEY, LlmCall } from "./llm-call";

const logger = initializeLogger();

/**
 * Model classes whose provider SDK Laminar instruments itself (`_llmType()`).
 * Their LLM calls are handed off: the provider span is the LLM span, with the
 * provider-specific attributes, and LangChain opens none of its own.
 */
const HANDOFF_LLM_TYPES = new Set(["openai", "azure_openai", "anthropic"]);

/**
 * The single handler injected into every LangChain `CallbackManager`. All its
 * state is keyed by LangChain run id, so it is shared by every instrumentation
 * instance (auto and manual) and patched module copy.
 */
const handler = new LaminarCallbackHandler(true);

type TopologyHolder = { topology?: Record<string, string> };

// The LangGraph topology of the graph run that is starting
const topologyStorage = new AsyncLocalStorage<TopologyHolder>();

handler.takeTopology = () => {
  const holder = topologyStorage.getStore();
  const topology = holder?.topology;
  if (holder) holder.topology = undefined;
  return topology;
};

/**
 * Run `fn` with `ctx` current in both the OTel context (read by OTel-aware
 * code) and Laminar's context stack (read by `Laminar.startSpan` and
 * Laminar's own provider instrumentations).
 */
const runUnder = <T>(ctx: Context, fn: () => T): T =>
  context.with(ctx, () =>
    LaminarContextManager.runWithIsolatedContext(
      [...LaminarContextManager.getContextStack(), ctx],
      fn,
    ),
  );

/**
 * Wrap an async iterator so each step runs through `run`.
 * `AsyncLocalStorage.run` and `context.with` only cover the synchronous part
 * of the call, so every `next` / `return` / `throw` needs its own.
 */
const wrapIterator = (
  iterator: any,
  run: <T>(fn: () => T) => T,
): AsyncIterableIterator<any> => ({
  next: (...args: any[]) => run(() => iterator.next(...args)),
  return: (value?: any) =>
    run(() =>
      typeof iterator.return === "function"
        ? iterator.return(value)
        : Promise.resolve({ done: true, value }),
    ),
  throw: (error?: any) =>
    run(() =>
      typeof iterator.throw === "function"
        ? iterator.throw(error)
        : Promise.reject(error),
    ),
  [Symbol.asyncIterator]() {
    return this;
  },
});

/**
 * Inject the handler into every `CallbackManager` LangChain configures.
 * `configure` delegates to the static `_configureSync`, and LangGraph calls
 * `_configureSync` directly, so this one method covers both.
 */
const wrapConfigureSync = (original: (...args: any[]) => any) =>
  function (this: any, inheritableHandlers?: any, ...rest: any[]) {
    const manager = original.call(this, inheritableHandlers, ...rest);
    if (!manager) {
      // No handlers, tags or tracing at all: configure one carrying ours,
      // so tags and metadata are applied exactly as LangChain would.
      return original.call(this, [handler], ...rest);
    }
    try {
      if (
        !manager.handlers?.some((h: any) => h?.name === HANDLER_NAME) &&
        typeof manager.addHandler === "function"
      ) {
        manager.addHandler(handler, true);
      }
    } catch (error) {
      logger.debug(`Failed to add the Laminar LangChain handler: ${error}`);
    }
    return manager;
  };

/**
 * Run user code that LangChain runs for a run (a lambda, a tool, a graph
 * node) under that run's span. LangChain passes it the run's child config,
 * whose callback manager's parent run id is that run.
 */
const wrapRunWithConfig = (original: (...args: any[]) => any) =>
  function (this: any, config: any, ...rest: any[]) {
    let ctx: Context | undefined;
    try {
      ctx = handler.contextFor(config?.callbacks?.getParentRunId?.());
    } catch {
      ctx = undefined;
    }
    if (!ctx) return original.call(this, config, ...rest);
    return runUnder(ctx, () => original.call(this, config, ...rest));
  };

/**
 * The context an LLM call runs under, or undefined to run it untouched (it is
 * nested in another LLM call, or tracing is suppressed).
 *
 * The call is handed off to Laminar's provider instrumentation when the model
 * wraps a provider SDK it instruments. Otherwise the handler records the LLM
 * span and provider instrumentations underneath are suppressed, so a call is
 * never recorded twice.
 */
const llmCallContext = (
  model: any,
  callbacks: any,
  startedRunManagers?: unknown,
): Context | undefined => {
  const active = context.active();
  if (active.getValue(LLM_CALL_KEY) || isTracingSuppressed(active)) {
    return undefined;
  }
  let parentRunId: string | undefined;
  let llmType: string | undefined;
  try {
    parentRunId = callbacks?.getParentRunId?.();
    llmType = model?._llmType?.();
  } catch {
    // Not knowing the parent or the type only degrades the trace
  }
  const base =
    handler.contextFor(parentRunId) ?? LaminarContextManager.getContext();
  // A cached call already fired its start callbacks, outside this wrapper, so
  // the handler records it
  const mode: LlmCall["mode"] =
    llmType && HANDOFF_LLM_TYPES.has(llmType) && !startedRunManagers
      ? "handoff"
      : "own";
  const call: LlmCall = { mode, recorded: false };
  const ctx = base.setValue(LLM_CALL_KEY, call);
  return mode === "own" ? suppressTracing(ctx) : ctx;
};

const wrapGenerateUncached = (original: (...args: any[]) => any) =>
  function (
    this: any,
    input: any,
    parsedOptions: any,
    handledOptions: any,
    startedRunManagers?: any,
    ...rest: any[]
  ) {
    const call = () =>
      original.call(
        this,
        input,
        parsedOptions,
        handledOptions,
        startedRunManagers,
        ...rest,
      );
    const ctx = llmCallContext(
      this,
      handledOptions?.callbacks,
      startedRunManagers,
    );
    return ctx ? runUnder(ctx, call) : call();
  };

const wrapModelStreamIterator = (original: (...args: any[]) => any) =>
  function (this: any, input: any, options: any, ...rest: any[]) {
    const ctx = llmCallContext(this, options?.callbacks);
    if (!ctx) return original.call(this, input, options, ...rest);
    const iterator = runUnder(ctx, () =>
      original.call(this, input, options, ...rest),
    );
    return wrapIterator(iterator, (fn) => runUnder(ctx, fn));
  };

/**
 * The graph topology, recorded on the graph's root span the way the Python
 * SDK does. Only the synchronous `getGraph` is used: it runs before the
 * graph does, and an async drawing would hold the run back.
 */
const topologyCache = new WeakMap<object, Record<string, string>>();

const graphTopology = (
  pregel: any,
  config: any,
): Record<string, string> | undefined => {
  const cached = topologyCache.get(pregel);
  if (cached) return cached;
  if (typeof pregel?.getGraph !== "function") return undefined;
  const graph = pregel.getGraph(config);
  if (!graph || graph instanceof Promise) return undefined;
  const nodes = Object.values(graph.nodes ?? {}).map((node: any) => ({
    id: node.id,
    name: node.name,
    metadata: node.metadata ?? null,
  }));
  const edges = (graph.edges ?? []).map((edge: any) => ({
    source: edge.source,
    target: edge.target,
    conditional: Boolean(edge.conditional),
  }));
  const topology = {
    "langgraph.nodes": JSON.stringify(nodes),
    "langgraph.edges": JSON.stringify(edges),
  };
  topologyCache.set(pregel, topology);
  return topology;
};

/**
 * Publish the graph topology for the graph's own run, which the handler
 * starts in the iterator's first step. Each iterator gets its own holder, so
 * concurrent graph runs never read each other's topology.
 */
const wrapPregelStreamIterator = (original: (...args: any[]) => any) =>
  function (this: any, input: any, options: any, ...rest: any[]) {
    let topology: Record<string, string> | undefined;
    try {
      topology = graphTopology(this, options);
    } catch (error) {
      logger.debug(`Failed to read the LangGraph topology: ${error}`);
    }
    const iterator = original.call(this, input, options, ...rest);
    if (!topology) return iterator;
    const holder: TopologyHolder = { topology };
    return wrapIterator(iterator, (fn) => topologyStorage.run(holder, fn));
  };

/**
 * `Pregel.prototype` from `@langchain/langgraph/pregel`, or the first
 * prototype that owns `_streamIterator` above a compiled graph class.
 */
const pregelPrototype = (module: any): any => {
  if (typeof module?.Pregel === "function") return module.Pregel.prototype;
  const graphClass =
    module?.CompiledStateGraph ?? module?.CompiledGraph ?? module;
  let proto = typeof graphClass === "function" ? graphClass.prototype : null;
  while (proto && proto !== Object.prototype) {
    if (Object.getOwnPropertyDescriptor(proto, "_streamIterator")) {
      return proto;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
};

const singletonPrototype = (module: any): any => {
  const singleton = module?.AsyncLocalStorageProviderSingleton;
  return singleton ? Object.getPrototypeOf(singleton) : undefined;
};

export type LangChainModules = {
  /** `@langchain/core/callbacks/manager` */
  callbackManagerModule?: any;
  /** `@langchain/core/singletons` */
  singletonsModule?: any;
  /** `@langchain/core/language_models/chat_models` */
  chatModelsModule?: any;
  /** `@langchain/core/language_models/llms` */
  llmsModule?: any;
  /** `@langchain/langgraph` or `@langchain/langgraph/pregel` */
  langgraphModule?: any;
};

const CORE_FILES = {
  callbackManager: ["@langchain/core/dist/callbacks/manager"],
  singletons: [
    // 1.x
    "@langchain/core/dist/singletons/async_local_storage/index",
    // 0.3.x defines it here; 1.x re-exports the same instance
    "@langchain/core/dist/singletons/index",
  ],
  chatModels: ["@langchain/core/dist/language_models/chat_models"],
  llms: ["@langchain/core/dist/language_models/llms"],
};

/**
 * Instruments LangChain (`@langchain/core`) and LangGraph
 * (`@langchain/langgraph`) through a callback handler injected into every
 * callback manager, with wrappers that run user code and provider SDK calls
 * under the right span.
 *
 * Calls made through LangChain's OpenAI and Anthropic integrations are left to
 * Laminar's OpenAI and Anthropic instrumentations, which record them as the
 * LLM span. Other model calls are recorded by the handler, with provider
 * instrumentations underneath suppressed.
 */
export class LangChainInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("langchain", config);
  }

  protected modules(): InstrumentedModule[] {
    // Each internal file is hooked both as `.cjs` and `.js`.
    const files = (
      names: string[],
      patch: (exports: any) => void,
      unpatch: (exports: any) => void,
    ): InstrumentedFile[] =>
      names.flatMap((name) =>
        [".cjs", ".js"].map((extension) => ({
          name: `${name}${extension}`,
          patch,
          unpatch,
        })),
      );

    return [
      {
        name: "@langchain/core",
        supportedVersions: [">=0.3.0"],
        files: [
          ...files(
            CORE_FILES.callbackManager,
            (exports) => this.patchCallbackManager(exports),
            (exports) => this.unpatchCallbackManager(exports),
          ),
          ...files(
            CORE_FILES.singletons,
            (exports) => this.patchSingletons(exports),
            (exports) => this.unpatchSingletons(exports),
          ),
          ...files(
            CORE_FILES.chatModels,
            (exports) => this.patchChatModels(exports),
            (exports) => this.unpatchChatModels(exports),
          ),
          ...files(
            CORE_FILES.llms,
            (exports) => this.patchLlms(exports),
            (exports) => this.unpatchLlms(exports),
          ),
        ],
      },
      {
        name: "@langchain/langgraph",
        supportedVersions: [">=0.2.0"],
        files: files(
          ["@langchain/langgraph/dist/pregel/index"],
          (exports) => this.patchLanggraph(exports),
          (exports) => this.unpatchLanggraph(exports),
        ),
      },
    ];
  }

  /**
   * Pass every module you use; a module left out is not traced. The model
   * modules are what lets OpenAI and Anthropic calls be recorded once, by the
   * provider instrumentation, instead of twice.
   */
  public override manuallyInstrument(modules: LangChainModules): void {
    const {
      callbackManagerModule,
      singletonsModule,
      chatModelsModule,
      llmsModule,
      langgraphModule,
    } = modules ?? {};
    if (
      !callbackManagerModule &&
      !singletonsModule &&
      !chatModelsModule &&
      !llmsModule &&
      !langgraphModule
    ) {
      diag.warn(
        "No modules in langchain manual instrumentation input. Pass at " +
          "least @langchain/core/callbacks/manager as callbackManagerModule.",
      );
      return;
    }
    diag.debug("Manually instrumenting LangChain");
    if (callbackManagerModule && !chatModelsModule) {
      // Without the model patches, LLM calls cannot be handed off to the
      // provider SDK instrumentations
      diag.warn(
        "LangChain chatModelsModule is missing from manual instrumentation " +
          "input. Chat model calls may be recorded twice. Pass " +
          "@langchain/core/language_models/chat_models as chatModelsModule.",
      );
    }
    if (callbackManagerModule) this.patchCallbackManager(callbackManagerModule);
    if (singletonsModule) this.patchSingletons(singletonsModule);
    if (chatModelsModule) this.patchChatModels(chatModelsModule);
    if (llmsModule) this.patchLlms(llmsModule);
    if (langgraphModule) {
      if (!pregelPrototype(langgraphModule)) {
        diag.warn(
          "Could not find Pregel in langchain manual instrumentation input. " +
            "Pass the @langchain/langgraph module as langgraphModule.",
        );
      } else {
        this.patchLanggraph(langgraphModule);
      }
    }
  }

  private patchCallbackManager(moduleExports: any): void {
    diag.debug("Patching @langchain/core CallbackManager");
    handler.traceContent = this.traceContent;
    this.patchOwnMethod(
      moduleExports?.CallbackManager,
      "_configureSync",
      wrapConfigureSync,
    );
  }

  private unpatchCallbackManager(moduleExports: any): void {
    this.unwrapMethod(moduleExports?.CallbackManager, "_configureSync");
  }

  private patchSingletons(moduleExports: any): void {
    diag.debug("Patching @langchain/core AsyncLocalStorageProvider");
    this.patchOwnMethod(
      singletonPrototype(moduleExports),
      "runWithConfig",
      wrapRunWithConfig,
    );
  }

  private unpatchSingletons(moduleExports: any): void {
    this.unwrapMethod(singletonPrototype(moduleExports), "runWithConfig");
  }

  private patchChatModels(moduleExports: any): void {
    diag.debug("Patching @langchain/core BaseChatModel");
    this.patchModel(moduleExports?.BaseChatModel?.prototype);
  }

  private unpatchChatModels(moduleExports: any): void {
    this.unpatchModel(moduleExports?.BaseChatModel?.prototype);
  }

  private patchLlms(moduleExports: any): void {
    diag.debug("Patching @langchain/core BaseLLM");
    this.patchModel(moduleExports?.BaseLLM?.prototype);
  }

  private unpatchLlms(moduleExports: any): void {
    this.unpatchModel(moduleExports?.BaseLLM?.prototype);
  }

  private patchModel(proto: any): void {
    this.patchOwnMethod(proto, "_generateUncached", wrapGenerateUncached);
    this.patchOwnMethod(proto, "_streamIterator", wrapModelStreamIterator);
  }

  private unpatchModel(proto: any): void {
    this.unwrapMethod(proto, "_generateUncached");
    this.unwrapMethod(proto, "_streamIterator");
  }

  private patchLanggraph(moduleExports: any): void {
    diag.debug("Patching @langchain/langgraph Pregel");
    this.patchOwnMethod(
      pregelPrototype(moduleExports),
      "_streamIterator",
      wrapPregelStreamIterator,
    );
  }

  private unpatchLanggraph(moduleExports: any): void {
    this.unwrapMethod(pregelPrototype(moduleExports), "_streamIterator");
  }

  /**
   * Wrap `target[method]` only where `target` itself defines it, so a
   * subclass prototype is never patched on top of its parent's wrapper.
   */
  private patchOwnMethod(
    target: any,
    method: string,
    wrap: (original: (...args: any[]) => any) => (...args: any[]) => any,
  ): void {
    if (!target || !Object.getOwnPropertyDescriptor(target, method)) return;
    this.wrapMethod(target, method, ({ original }) => wrap(original));
  }
}
