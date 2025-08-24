import { Context, Span, SpanOptions, trace, Tracer } from "@opentelemetry/api";

import { LaminarContextManager } from "./context";
import { LaminarSpan } from "./span";


export class LaminarTracer implements Tracer {
  private _tracer: Tracer;
  constructor(tracer: Tracer) {
    this._tracer = tracer;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public startSpan(name: string, options: SpanOptions, context: Context): Span {
    return new LaminarSpan(
      this._tracer.startSpan(name, options, LaminarContextManager.getContext()),
    );
  }

  public startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  public startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  public startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;

  public startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn?: SpanOptions | F,
    contextOrFn?: Context | F,
    fn?: F,
  ): ReturnType<F> {
    // Use the provided context if available, otherwise get the current context
    let contextToUse: Context;
    if (typeof contextOrFn !== "function" && contextOrFn !== undefined) {
      contextToUse = contextOrFn;
    } else {
      contextToUse = LaminarContextManager.getContext();
    }

    const wrapped = (fn: F) => (span: Span): ReturnType<F> => {
      const laminarSpan = new LaminarSpan(span);
      const newContext = trace.setSpan(contextToUse, laminarSpan);
      const currentStack = LaminarContextManager.getContextStack();
      const res = LaminarContextManager.runWithIsolatedContext(
        [...currentStack, newContext],
        () => fn(laminarSpan) as ReturnType<F>,
      );
      // We don't pop the context here, because it is the caller's responsibility to
      // end the span. LaminarSpan.end() will pop the context.
      return res;
    };
    if (typeof optionsOrFn === "function") {
      return this._tracer.startActiveSpan(name, {}, contextToUse, wrapped(optionsOrFn));
    }
    if (typeof contextOrFn === "function") {
      return this._tracer.startActiveSpan(name, {}, contextToUse, wrapped(contextOrFn));
    }

    // Use the provided context or the current Laminar context
    return this._tracer.startActiveSpan(
      name,
      optionsOrFn as SpanOptions,
      contextToUse,
      wrapped(fn as F),
    );
  }
}

