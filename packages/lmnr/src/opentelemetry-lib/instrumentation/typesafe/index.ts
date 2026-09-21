import { context, diag, trace } from "@opentelemetry/api";
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
  recordError,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

const PATCH_STATE_SYMBOL = Symbol("lmnr.typesafe.patch-state");

type PatchState = {
  traceContent: boolean;
  systemOne: (...args: any[]) => any;
};

export class TypeSafeInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/typesafe-instrumentation", SDK_VERSION, { enabled: true });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@typesafe-ai/sdk",
      [">=0.1.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(typeSafeModule: any): void {
    diag.debug("Manually instrumenting @typesafe-ai/sdk");
    const TypeSafeClientClass = this.resolveClientClass(typeSafeModule);
    if (TypeSafeClientClass) {
      this.patchClientClass(TypeSafeClientClass);
    } else {
      diag.warn(
        "Could not find TypeSafeClient class in typesafe manual instrumentation input. " +
          "Pass either the TypeSafeClient class or the module object with a TypeSafeClient export.",
      );
    }
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @typesafe-ai/sdk");
    const TypeSafeClientClass = this.resolveClientClass(moduleExports);
    if (TypeSafeClientClass) {
      this.patchClientClass(TypeSafeClientClass);
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @typesafe-ai/sdk");
    const TypeSafeClientClass = this.resolveClientClass(moduleExports);
    if (TypeSafeClientClass) {
      this.unpatchClientClass(TypeSafeClientClass);
    }
  }

  private resolveClientClass(moduleOrClass: any): any {
    if (typeof moduleOrClass === "function") {
      return moduleOrClass;
    }
    if (typeof moduleOrClass?.TypeSafeClient === "function") {
      return moduleOrClass.TypeSafeClient;
    }
    return undefined;
  }

  private patchClientClass(TypeSafeClientClass: any): void {
    const proto = TypeSafeClientClass.prototype;
    const existing = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (existing) {
      existing.traceContent = this.traceContent;
      return;
    }
    if (typeof proto.systemOne !== "function") {
      diag.warn("Could not patch TypeSafeClient.prototype.systemOne.");
      return;
    }

    const state: PatchState = {
      traceContent: this.traceContent,
      systemOne: proto.systemOne,
    };
    proto[PATCH_STATE_SYMBOL] = state;
    proto.systemOne = wrapSystemOne(state);
  }

  private unpatchClientClass(TypeSafeClientClass: any): void {
    const proto = TypeSafeClientClass.prototype;
    const state = proto[PATCH_STATE_SYMBOL] as PatchState | undefined;
    if (!state) return;

    proto.systemOne = state.systemOne;
    delete proto[PATCH_STATE_SYMBOL];
  }
}

const wrapSystemOne = (state: PatchState) =>
  function (this: any, request: any, options?: any) {
    const original = state.systemOne;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, options);
    }

    const { traceContent } = state;
    const span = Laminar.startSpan({
      name: "typesafe.system_one",
      spanType: "LLM",
    }) as LaminarSpan;
    span.setAttribute("gen_ai.system", "typesafe");
    setRequestAttributes(span, request, this?.defaultModel, traceContent);

    // `systemOne` returns an APIPromise whose `then` triggers the SDK's body
    // parse, and `asResponse()` hands the caller the same Response object. So
    // the wrapper must return the promise untouched (no async/await, no
    // Laminar.withSpan promise chaining) and record from a clone of the raw
    // response, which the SDK has already buffered.
    let promise: any;
    try {
      promise = context.with(trace.setSpan(context.active(), span), () =>
        original.call(this, request, options),
      );
    } catch (error) {
      // Synchronous request validation, e.g. an empty questions map.
      recordError(span, error);
      span.end();
      throw error;
    }

    const onError = (error: unknown) => {
      recordError(span, error);
      span.end();
    };
    if (typeof promise?.asResponse === "function") {
      promise.asResponse().then(async (response: Response) => {
        try {
          setResponseAttributes(
            span,
            await response.clone().json(),
            traceContent,
          );
        } catch {
          // Leave the span without response attributes.
        }
        span.end();
      }, onError);
    } else if (typeof promise?.then === "function") {
      // Defensive: a parsed result has the same shape as the raw body.
      promise.then((result: any) => {
        setResponseAttributes(span, result, traceContent);
        span.end();
      }, onError);
    } else {
      span.end();
    }
    return promise;
  };
