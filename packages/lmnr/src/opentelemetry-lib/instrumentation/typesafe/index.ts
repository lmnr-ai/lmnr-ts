import { context, diag, trace } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../shared/base";
import { finishSpan, safely } from "../shared/utils";
import { setRequestAttributes, setResponseAttributes } from "./utils";

export class TypeSafeInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("typesafe", config);
  }

  /**
   * Manual instrumentation accepts the `TypeSafeClient` class or the module
   * object with a `TypeSafeClient` export.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@typesafe-ai/sdk",
        supportedVersions: [">=0.1.0"],
        patch: (moduleExports) => {
          const proto = resolveClientClass(moduleExports)?.prototype;
          if (proto && typeof proto.systemOne !== "function") {
            diag.warn("Could not patch TypeSafeClient.prototype.systemOne.");
            return;
          }
          this.wrapMethod(proto, "systemOne", wrapSystemOne);
        },
        unpatch: (moduleExports) => {
          this.unwrapMethod(
            resolveClientClass(moduleExports)?.prototype,
            "systemOne",
          );
        },
        accepts: (input) => resolveClientClass(input) !== undefined,
      },
    ];
  }
}

const resolveClientClass = (moduleOrClass: any): any => {
  if (typeof moduleOrClass === "function") {
    return moduleOrClass;
  }
  if (typeof moduleOrClass?.TypeSafeClient === "function") {
    return moduleOrClass.TypeSafeClient;
  }
  return undefined;
};

const wrapSystemOne = (patched: PatchedMethod) =>
  function (this: any, request: any, options?: any) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, options);
    }

    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: "typesafe.system_one",
      spanType: "LLM",
    });
    span.setAttribute("gen_ai.system", "typesafe");
    safely(() =>
      setRequestAttributes(span, request, this?.defaultModel, traceContent),
    );

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
      finishSpan(span, error);
      throw error;
    }

    const onError = (error: unknown) => finishSpan(span, error);
    // Recording must never break the caller: any surprise from a future
    // APIPromise shape degrades to a span without response attributes.
    try {
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
          safely(() => setResponseAttributes(span, result, traceContent));
          span.end();
        }, onError);
      } else {
        span.end();
      }
    } catch {
      span.end();
    }
    return promise;
  };
