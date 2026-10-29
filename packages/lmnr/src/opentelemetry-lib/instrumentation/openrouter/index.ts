import { context, diag } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { Laminar } from "../../../laminar";
import { LaminarSpan } from "../../tracing/span";
import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
} from "../shared/base";
import {
  isAsyncIterable,
  ResourceKind,
  recordError,
  responsesInputMessages,
  setRequestAttributes,
  setResponseAttributes,
  wrapStream,
} from "./utils";

const WRAPPED_SYMBOL = Symbol("lmnr.openrouter.wrapped");
const PATCH_STATE_SYMBOL = Symbol("lmnr.openrouter.patch-state");

/** The method each resource sends on, and the key its request is wrapped in. */
const RESOURCE_METHODS: Record<
  ResourceKind,
  { method: string; requestKey: string }
> = {
  chat: { method: "send", requestKey: "chatRequest" },
  responses: { method: "send", requestKey: "responsesRequest" },
  embeddings: { method: "generate", requestKey: "requestBody" },
};

const RESOURCE_KINDS = Object.keys(RESOURCE_METHODS) as ResourceKind[];

type PatchState = {
  instrumentation: LaminarInstrumentation;
  chat: PropertyDescriptor | undefined;
  responses: PropertyDescriptor | undefined;
  embeddings: PropertyDescriptor | undefined;
  callModel: ((...args: any[]) => any) | undefined;
};

export class OpenRouterInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("openrouter", config);
  }

  /**
   * Manual instrumentation accepts the `OpenRouter` class or the module
   * object with an `OpenRouter` export.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@openrouter/sdk",
        supportedVersions: [">=1.0.0"],
        patch: (moduleExports) => {
          const OpenRouterClass = resolveOpenRouterClass(moduleExports);
          if (OpenRouterClass) this.patchOpenRouterClass(OpenRouterClass);
        },
        unpatch: (moduleExports) => {
          const OpenRouterClass = resolveOpenRouterClass(moduleExports);
          if (OpenRouterClass) this.unpatchOpenRouterClass(OpenRouterClass);
        },
        accepts: (input) => resolveOpenRouterClass(input) !== undefined,
      },
    ];
  }

  private patchOpenRouterClass(OpenRouterClass: any): void {
    const proto = OpenRouterClass.prototype;
    const existing = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (existing) {
      existing.instrumentation = this;
      return;
    }

    const state: PatchState = {
      instrumentation: this,
      chat: Object.getOwnPropertyDescriptor(proto, "chat"),
      responses: Object.getOwnPropertyDescriptor(proto, "responses"),
      embeddings: Object.getOwnPropertyDescriptor(proto, "embeddings"),
      callModel: proto.callModel,
    };
    proto[PATCH_STATE_SYMBOL] = state;

    for (const kind of RESOURCE_KINDS) {
      patchResourceGetter(proto, kind, state);
    }
    if (typeof state.callModel === "function") {
      patchCallModel(proto, state);
    }
  }

  private unpatchOpenRouterClass(OpenRouterClass: any): void {
    const proto = OpenRouterClass.prototype;
    const state = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (!state) return;

    for (const kind of RESOURCE_KINDS) {
      if (state[kind]) {
        Object.defineProperty(proto, kind, state[kind]);
      } else {
        delete proto[kind];
      }
    }
    if (state.callModel) {
      proto.callModel = state.callModel;
    }
    delete proto[PATCH_STATE_SYMBOL];
  }
}

const resolveOpenRouterClass = (moduleOrClass: any): any => {
  if (typeof moduleOrClass === "function") {
    return moduleOrClass;
  }
  if (typeof moduleOrClass?.OpenRouter === "function") {
    return moduleOrClass.OpenRouter;
  }
  return undefined;
};

const patchResourceGetter = (
  proto: any,
  kind: ResourceKind,
  state: PatchState,
): void => {
  const descriptor = state[kind];
  if (!descriptor?.get || !descriptor.configurable) {
    diag.warn(`Could not patch OpenRouter.prototype.${kind} getter.`);
    return;
  }
  const originalGet = descriptor.get;
  Object.defineProperty(proto, kind, {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get() {
      const resource = originalGet.call(this);
      patchResourceMethod(resource, kind, state);
      return resource;
    },
  });
};

const patchResourceMethod = (
  resource: any,
  kind: ResourceKind,
  state: PatchState,
): void => {
  if (!resource || resource[WRAPPED_SYMBOL]) return;
  const { method, requestKey } = RESOURCE_METHODS[kind];
  if (typeof resource[method] !== "function") return;

  const original = resource[method].bind(resource);

  resource[method] = async (request: any, options?: any) => {
    if (isTracingSuppressed(context.active())) {
      return original(request, options);
    }

    const { instrumentation } = state;
    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: `openrouter.${kind}`,
      spanType: "LLM",
    });
    span.setAttribute("gen_ai.system", "openrouter");
    setRequestAttributes(span, kind, request?.[requestKey], traceContent);

    try {
      const response = await Laminar.withSpan(span, () =>
        original(request, options),
      );
      if (isAsyncIterable(response)) {
        return wrapStream(span, kind, response, traceContent);
      }
      setResponseAttributes(span, kind, response, traceContent);
      span.end();
      return response;
    } catch (error) {
      recordError(span, error);
      span.end();
      throw error;
    }
  };
  resource[WRAPPED_SYMBOL] = true;
};

const patchCallModel = (proto: any, state: PatchState): void => {
  const originalCallModel = state.callModel as (...args: any[]) => any;

  proto.callModel = function (request: any, options?: any) {
    if (isTracingSuppressed(context.active())) {
      return originalCallModel.call(this, request, options);
    }

    const { instrumentation } = state;
    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: "openrouter.call_model",
      input: traceContent ? responsesInputMessages(request) : undefined,
    });

    const tools = Array.isArray(request?.tools)
      ? request.tools.map((tool: any) => wrapTool(tool, span, instrumentation))
      : undefined;
    try {
      const result = Laminar.withSpan(span, () =>
        originalCallModel.call(
          this,
          tools ? { ...request, tools } : request,
          options,
        ),
      );
      instrumentModelResult(result, span, instrumentation);
      return result;
    } catch (error) {
      recordError(span, error);
      span.end();
      throw error;
    }
  };
};

const wrapTool = (
  tool: any,
  parentSpan: LaminarSpan,
  instrumentation: LaminarInstrumentation,
) => {
  const { traceContent } = instrumentation;
  const fn = tool?.function;
  if (typeof fn?.execute !== "function" || fn.eventSchema) return tool;

  const execute = fn.execute;
  return {
    ...tool,
    function: {
      ...fn,
      execute: (input: any, ctx: any) =>
        Laminar.withSpan(parentSpan, () => {
          const span = instrumentation.startSpan({
            name: fn.name,
            spanType: "TOOL",
            input: traceContent ? input : undefined,
          });
          return Laminar.withSpan(
            span,
            async () => {
              try {
                const result = await execute(input, ctx);
                if (traceContent) span.setOutput(result);
                return result;
              } catch (error) {
                recordError(span, error);
                throw error;
              }
            },
            true,
          );
        }),
    },
  };
};

/**
 * ModelResult runs lazily on first consumption. Each turn's request goes through
 * getInitialResponse / makeFollowupRequest, and executeToolsIfNeeded is the
 * memoized promise every consumption path awaits.
 */
const instrumentModelResult = (
  result: any,
  parentSpan: LaminarSpan,
  instrumentation: LaminarInstrumentation,
): void => {
  const { traceContent } = instrumentation;
  if (!result || typeof result.executeToolsIfNeeded !== "function") {
    parentSpan.end();
    return;
  }

  for (const method of ["getInitialResponse", "makeFollowupRequest"]) {
    if (typeof result[method] !== "function") continue;
    const original = result[method].bind(result);
    result[method] = (...args: any[]) =>
      Laminar.withSpan(parentSpan, () => {
        const span = instrumentation.startSpan({
          name: "openrouter.responses",
          spanType: "LLM",
        });
        span.setAttribute("gen_ai.system", "openrouter");
        return Laminar.withSpan(
          span,
          async () => {
            try {
              const response = await original(...args);
              setRequestAttributes(
                span,
                "responses",
                result.resolvedRequest,
                traceContent,
              );
              setResponseAttributes(span, "responses", response, traceContent);
              return response;
            } catch (error) {
              recordError(span, error);
              throw error;
            }
          },
          true,
        );
      });
  }

  const originalExecute = result.executeToolsIfNeeded.bind(result);
  let execution: Promise<void> | undefined;
  result.executeToolsIfNeeded = () => {
    if (execution) return execution;
    const promise: Promise<void> = originalExecute();
    execution = promise;
    promise.then(
      () => {
        if (traceContent && result.finalResponse?.output) {
          parentSpan.setOutput(result.finalResponse.output);
        }
        parentSpan.end();
      },
      (error: unknown) => {
        recordError(parentSpan, error);
        parentSpan.end();
      },
    );
    return execution;
  };
};
