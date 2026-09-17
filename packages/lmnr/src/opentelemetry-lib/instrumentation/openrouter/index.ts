import { context, diag } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { LaminarSpan } from "../../tracing/span";
import {
  isAsyncIterable,
  recordError,
  responsesInputMessages,
  SendKind,
  setRequestAttributes,
  setResponseAttributes,
  wrapStream,
} from "./utils";

const WRAPPED_SYMBOL = Symbol("lmnr.openrouter.wrapped");
const PATCH_STATE_SYMBOL = Symbol("lmnr.openrouter.patch-state");

type PatchState = {
  traceContent: boolean;
  chat: PropertyDescriptor | undefined;
  responses: PropertyDescriptor | undefined;
  callModel: ((...args: any[]) => any) | undefined;
};

export class OpenRouterInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/openrouter-instrumentation", SDK_VERSION, { enabled: true });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@openrouter/sdk",
      [">=1.0.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(openRouterModule: any): void {
    diag.debug("Manually instrumenting @openrouter/sdk");
    const OpenRouterClass = this.resolveOpenRouterClass(openRouterModule);
    if (OpenRouterClass) {
      this.patchOpenRouterClass(OpenRouterClass);
    } else {
      diag.warn(
        "Could not find OpenRouter class in openrouter manual instrumentation input. " +
          "Pass either the OpenRouter class or the module object with an OpenRouter export.",
      );
    }
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @openrouter/sdk");
    const OpenRouterClass = this.resolveOpenRouterClass(moduleExports);
    if (OpenRouterClass) {
      this.patchOpenRouterClass(OpenRouterClass);
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @openrouter/sdk");
    const OpenRouterClass = this.resolveOpenRouterClass(moduleExports);
    if (OpenRouterClass) {
      this.unpatchOpenRouterClass(OpenRouterClass);
    }
  }

  private resolveOpenRouterClass(moduleOrClass: any): any {
    if (typeof moduleOrClass === "function") {
      return moduleOrClass;
    }
    if (typeof moduleOrClass?.OpenRouter === "function") {
      return moduleOrClass.OpenRouter;
    }
    return undefined;
  }

  private patchOpenRouterClass(OpenRouterClass: any): void {
    const proto = OpenRouterClass.prototype;
    const existing = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (existing) {
      existing.traceContent = this.traceContent;
      return;
    }

    const state: PatchState = {
      traceContent: this.traceContent,
      chat: Object.getOwnPropertyDescriptor(proto, "chat"),
      responses: Object.getOwnPropertyDescriptor(proto, "responses"),
      callModel: proto.callModel,
    };
    proto[PATCH_STATE_SYMBOL] = state;

    patchResourceGetter(proto, "chat", state);
    patchResourceGetter(proto, "responses", state);
    if (typeof state.callModel === "function") {
      patchCallModel(proto, state);
    }
  }

  private unpatchOpenRouterClass(OpenRouterClass: any): void {
    const proto = OpenRouterClass.prototype;
    const state = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (!state) return;

    for (const name of ["chat", "responses"] as const) {
      if (state[name]) {
        Object.defineProperty(proto, name, state[name]);
      } else {
        delete proto[name];
      }
    }
    if (state.callModel) {
      proto.callModel = state.callModel;
    }
    delete proto[PATCH_STATE_SYMBOL];
  }
}

const patchResourceGetter = (
  proto: any,
  kind: SendKind,
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
      patchSend(resource, kind, state);
      return resource;
    },
  });
};

const patchSend = (resource: any, kind: SendKind, state: PatchState): void => {
  if (!resource || resource[WRAPPED_SYMBOL]) return;
  if (typeof resource.send !== "function") return;

  const originalSend = resource.send.bind(resource);
  const requestKey = kind === "chat" ? "chatRequest" : "responsesRequest";

  resource.send = async (request: any, options?: any) => {
    if (isTracingSuppressed(context.active())) {
      return originalSend(request, options);
    }

    const { traceContent } = state;
    const span = Laminar.startSpan({
      name: `openrouter.${kind}`,
      spanType: "LLM",
    }) as LaminarSpan;
    span.setAttribute("gen_ai.system", "openrouter");
    setRequestAttributes(span, kind, request?.[requestKey], traceContent);

    try {
      const response = await Laminar.withSpan(span, () =>
        originalSend(request, options),
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

    const { traceContent } = state;
    const span = Laminar.startSpan({
      name: "openrouter.call_model",
      input: traceContent ? responsesInputMessages(request) : undefined,
    }) as LaminarSpan;

    const tools = Array.isArray(request?.tools)
      ? request.tools.map((tool: any) => wrapTool(tool, span, traceContent))
      : undefined;
    try {
      const result = Laminar.withSpan(span, () =>
        originalCallModel.call(
          this,
          tools ? { ...request, tools } : request,
          options,
        ),
      );
      instrumentModelResult(result, span, traceContent);
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
  traceContent: boolean,
) => {
  const fn = tool?.function;
  if (typeof fn?.execute !== "function" || fn.eventSchema) return tool;

  const execute = fn.execute;
  return {
    ...tool,
    function: {
      ...fn,
      execute: (input: any, ctx: any) =>
        Laminar.withSpan(parentSpan, () => {
          const span = Laminar.startSpan({
            name: fn.name,
            spanType: "TOOL",
            input: traceContent ? input : undefined,
          }) as LaminarSpan;
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
  traceContent: boolean,
): void => {
  if (!result || typeof result.executeToolsIfNeeded !== "function") {
    parentSpan.end();
    return;
  }

  for (const method of ["getInitialResponse", "makeFollowupRequest"]) {
    if (typeof result[method] !== "function") continue;
    const original = result[method].bind(result);
    result[method] = (...args: any[]) =>
      Laminar.withSpan(parentSpan, () => {
        const span = Laminar.startSpan({
          name: "openrouter.responses",
          spanType: "LLM",
        }) as LaminarSpan;
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
