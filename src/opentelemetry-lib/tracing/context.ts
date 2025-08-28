import { Context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";

import { LaminarSpan } from "./span";

export class LaminarContextManager {
  private static _asyncLocalStorage = new AsyncLocalStorage<Context[]>();

  public static getContext(): Context {
    const contexts = this._asyncLocalStorage.getStore() || [];

    // Walk through contexts from most recent to oldest
    // We're doing it this way because we want to return the most recent context
    // that has an active span
    // This is primarily for the cases when span is started in one async context
    // and ended in another
    for (let i = contexts.length - 1; i >= 0; i--) {
      const context = contexts[i];
      const span = trace.getSpan(context);

      if (!span) {
        // No span in this context, it's valid
        return context;
      }

      // Check if the span in this context has been ended
      try {
        const isActive = LaminarSpan.isSpanActive(span.spanContext().spanId);
        if (isActive) {
          // Span is still active, use this context
          return context;
        }
        // Span has been ended, continue to parent context
      } catch {
        // If we can't check the span, assume it's valid
        return context;
      }
    }

    // No valid context found, return ROOT_CONTEXT
    return ROOT_CONTEXT;
  }

  public static pushContext(context: Context) {
    const contexts = this._asyncLocalStorage.getStore() || [];
    const newContexts = [...contexts, context];
    this._asyncLocalStorage.enterWith(newContexts);
  }

  public static popContext() {
    const contexts = this._asyncLocalStorage.getStore() || [];
    if (contexts.length > 0) {
      // Remove the last context and filter out any contexts with inactive spans
      const newContexts = contexts.slice(0, -1).filter(context => {
        const span = trace.getSpan(context);

        if (!span) {
          // No span in this context, it's valid
          return true;
        }

        // Check if the span in this context has been ended
        try {
          return LaminarSpan.isSpanActive(span.spanContext().spanId);
        } catch {
          // If we can't check the span, assume it's valid
          return true;
        }
      });

      this._asyncLocalStorage.enterWith(newContexts);
    }
  }

  public static clearContexts() {
    this._asyncLocalStorage.enterWith([]);
  }

  public static getContextStack(): Context[] {
    return this._asyncLocalStorage.getStore() || [];
  }

  /**
   * Run a function with an isolated context stack.
   * This ensures that parallel executions don't interfere with each other.
   */
  public static runWithIsolatedContext<T>(initialStack: Context[], fn: () => T): T {
    return this._asyncLocalStorage.run(initialStack, fn);
  }
}

