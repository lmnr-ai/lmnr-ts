import { Context, createContextKey, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";

import { TraceType, TracingLevel } from "../../types";
import { LaminarSpan } from "./span";

export const CONTEXT_SPAN_PATH_KEY = createContextKey("span_path");
export const ASSOCIATION_PROPERTIES_KEY = createContextKey(
  "association_properties",
);
export const CONTEXT_GLOBAL_METADATA_KEY = createContextKey(
  "global_metadata",
);

export class LaminarContextManager {
  private static _asyncLocalStorage = new AsyncLocalStorage<Context[]>();
  // Static registry for cross-async span management
  // We're keeping track of spans have started (and running) here for the cases when span
  // is started in one async context and ended in another
  // We use this registry to ignore the context of spans that were already ended in
  // another async context.
  // LaminarSpan adds and removes itself to and from this registry in start()
  // and end() methods respectively.
  private static _activeSpans: Set<string> = new Set();

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

      if (!span.isRecording() && span.spanContext().isRemote) {
        // Span is remote and not recording, it's valid
        return context;
      }

      if (!(span instanceof LaminarSpan)) {
        // Span is not a Laminar span, it's valid
        return context;
      }

      if (!span.isActivated) {
        // Span is not activated by Laminar.startActiveSpan(), it's valid
        return context;
      }

      // Check if the span in this context has been ended
      try {
        const isActive = this._activeSpans.has(span.spanContext().spanId);
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
          return this._activeSpans.has(span.spanContext().spanId);
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

  public static clearActiveSpans() {
    this._activeSpans.clear();
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

  public static addActiveSpan(spanId: string): void {
    this._activeSpans.add(spanId);
  }

  public static removeActiveSpan(spanId: string): void {
    this._activeSpans.delete(spanId);
  }

  public static setAssociationProperties(span: LaminarSpan): Context {
    const properties = span.laminarAssociationProperties;
    const userId = properties.userId;
    const sessionId = properties.sessionId;
    const traceType = properties.traceType;
    const metadata = properties.metadata;
    const tracingLevel = properties.tracingLevel;

    let entityContext = this.getContext();
    entityContext = entityContext.setValue(ASSOCIATION_PROPERTIES_KEY, {
      userId: userId,
      sessionId: sessionId,
      traceType: traceType,
      metadata: metadata,
      tracingLevel: tracingLevel,
    });
    return entityContext;
  }

  public static setGlobalMetadata(globalMetadata: Record<string, any>) {
    let entityContext = this.getContext();
    entityContext = entityContext.setValue(CONTEXT_GLOBAL_METADATA_KEY, globalMetadata);
    return entityContext;
  }

  public static getGlobalMetadata(): Record<string, any> {
    const entityContext = this.getContext();
    return entityContext.getValue(CONTEXT_GLOBAL_METADATA_KEY) ?? {};
  }

  public static getAssociationProperties(): {
    userId?: string;
    sessionId?: string;
    traceType?: TraceType;
    tracingLevel?: TracingLevel;
    metadata?: Record<string, any>;
  } {
    const entityContext = this.getContext();
    return entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};
  }
}
