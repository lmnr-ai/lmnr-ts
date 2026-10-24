import { AsyncLocalStorage } from "node:async_hooks";

import { Context, context, diag } from "@opentelemetry/api";
import { isTracingSuppressed, suppressTracing } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { HANDLER_NAME, LaminarCallbackHandler } from "./callback-handler";
import { LLM_CALL_KEY, LlmCall } from "./llm-call";

const logger = initializeLogger();

const PATCH_DATA_SYMBOL = Symbol("lmnr.langchain.patchData");

// Original methods, keyed by method name
type PatchData = Record<string, (...args: any[]) => any>;

// Patch data lives on the exact object it wraps, never an inherited one.
const hasOwnPatchData = (target: any): boolean =>
  Object.getOwnPropertyDescriptor(target, PATCH_DATA_SYMBOL) !== undefined;

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
 * Replace the own method `target[method]` with `wrap(original)`. Already
 * patched methods are left alone, so repeated initialization never
 * double-wraps.
 */
const patchMethod = (
  target: any,
  method: string,
  wrap: (original: (...args: any[]) => any) => (...args: any[]) => any,
): void => {
  if (
    !target ||
    !Object.getOwnPropertyDescriptor(target, method) ||
    typeof target[method] !== "function"
  ) {
    return;
  }
  if (!hasOwnPatchData(target)) {
    Object.defineProperty(target, PATCH_DATA_SYMBOL, {
      value: {},
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  const patchData: PatchData = target[PATCH_DATA_SYMBOL];
  if (patchData[method]) return;
  const original = target[method];
  patchData[method] = original;
  target[method] = wrap(original);
};

const unpatchMethod = (target: any, method: string): void => {
  if (!target || !hasOwnPatchData(target)) return;
  const patchData: PatchData = target[PATCH_DATA_SYMBOL];
  const original = patchData[method];
  if (!original) return;
  target[method] = original;
  delete patchData[method];
  if (Object.keys(patchData).length === 0) {
    delete target[PATCH_DATA_SYMBOL];
  }
};

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
export class LangChainInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/langchain-instrumentation", SDK_VERSION, {
      enabled: true,
    });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition[] {
    const coreFiles = (
      names: string[],
      patch: (exports: any) => void,
      unpatch: (exports: any) => void,
    ) =>
      names.flatMap((name) =>
        [".cjs", ".js"].map(
          (extension) =>
            new InstrumentationNodeModuleFile(
              `${name}${extension}`,
              [">=0.3.0"],
              (exports: any) => {
                patch.call(this, exports);
                return exports;
              },
              (exports: any) => {
                if (exports) unpatch.call(this, exports);
              },
            ),
        ),
      );

    const core = new InstrumentationNodeModuleDefinition(
      "@langchain/core",
      [">=0.3.0"],
      undefined,
      undefined,
      [
        ...coreFiles(
          CORE_FILES.callbackManager,
          this.patchCallbackManager,
          this.unpatchCallbackManager,
        ),
        ...coreFiles(
          CORE_FILES.singletons,
          this.patchSingletons,
          this.unpatchSingletons,
        ),
        ...coreFiles(
          CORE_FILES.chatModels,
          this.patchChatModels,
          this.unpatchChatModels,
        ),
        ...coreFiles(CORE_FILES.llms, this.patchLlms, this.unpatchLlms),
      ],
    );

    const langgraph = new InstrumentationNodeModuleDefinition(
      "@langchain/langgraph",
      [">=0.2.0"],
      undefined,
      undefined,
      [".cjs", ".js"].map(
        (extension) =>
          new InstrumentationNodeModuleFile(
            `@langchain/langgraph/dist/pregel/index${extension}`,
            [">=0.2.0"],
            (exports: any) => {
              this.patchLanggraph(exports);
              return exports;
            },
            (exports: any) => {
              if (exports) this.unpatchLanggraph(exports);
            },
          ),
      ),
    );

    return [core, langgraph];
  }

  /**
   * Pass every module you use; a module left out is not traced. The model
   * modules are what lets OpenAI and Anthropic calls be recorded once, by the
   * provider instrumentation, instead of twice.
   */
  public manuallyInstrument(modules: LangChainModules): void {
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
    patchMethod(
      moduleExports?.CallbackManager,
      "_configureSync",
      wrapConfigureSync,
    );
  }

  private unpatchCallbackManager(moduleExports: any): void {
    unpatchMethod(moduleExports?.CallbackManager, "_configureSync");
  }

  private patchSingletons(moduleExports: any): void {
    diag.debug("Patching @langchain/core AsyncLocalStorageProvider");
    patchMethod(
      singletonPrototype(moduleExports),
      "runWithConfig",
      wrapRunWithConfig,
    );
  }

  private unpatchSingletons(moduleExports: any): void {
    unpatchMethod(singletonPrototype(moduleExports), "runWithConfig");
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
    patchMethod(proto, "_generateUncached", wrapGenerateUncached);
    patchMethod(proto, "_streamIterator", wrapModelStreamIterator);
  }

  private unpatchModel(proto: any): void {
    unpatchMethod(proto, "_generateUncached");
    unpatchMethod(proto, "_streamIterator");
  }

  private patchLanggraph(moduleExports: any): void {
    diag.debug("Patching @langchain/langgraph Pregel");
    patchMethod(
      pregelPrototype(moduleExports),
      "_streamIterator",
      wrapPregelStreamIterator,
    );
  }

  private unpatchLanggraph(moduleExports: any): void {
    unpatchMethod(pregelPrototype(moduleExports), "_streamIterator");
  }
}
