import { TraceType, TracingLevel } from "@lmnr-ai/types";
import {
  Context, context as contextApi,
  createContextKey, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";

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
  private static _globalMetadata: Record<string, any> = {};
  private static _inheritGlobalContext: boolean = false;
  // Static registry for cross-async span management
  // We're keeping track of spans have started (and running) here for the cases when span
  // is started in one async context and ended in another
  // We use this registry to ignore the context of spans that were already ended in
  // another async context.
  // LaminarSpan adds and removes itself to and from this registry in start()
  // and end() methods respectively.
  private static _activeSpans: Set<string> = new Set();
  // Process-global stack of contexts marked globally active via
  // `Laminar.startActiveSpan({ global: true })`. Unlike the AsyncLocalStorage
  // stack, this one is visible from any async task in the process. We use it
  // as the fallback parent when the ALS stack is empty. Spans push onto this
  // stack when started globally and pop in `LaminarSpan.end()`.
  private static _globalActiveContexts: Context[] = [];

  private constructor() {
    throw new Error("LaminarContextManager is a static class and cannot be instantiated");
  }

  private static isValidContext(context: Context): boolean {
    const span = trace.getSpan(context);
    if (!span) {
      return true;
    }
    if (!span.isRecording() && span.spanContext().isRemote) {
      return true;
    }
    if (!(span instanceof LaminarSpan)) {
      return true;
    }
    if (!span.isActivated) {
      return true;
    }
    try {
      return this._activeSpans.has(span.spanContext().spanId);
    } catch {
      return true;
    }
  }

  private static findLatestValidContext(contexts: Context[]): Context | undefined {
    // Walk through contexts from most recent to oldest and return the most
    // recent one that is still valid (has a live activated span, or has no
    // span at all).
    for (let i = contexts.length - 1; i >= 0; i--) {
      if (this.isValidContext(contexts[i])) {
        return contexts[i];
      }
    }
    return undefined;
  }

  public static getContext(): Context {
    // Prefer the per-async context stack so local control flow wins over any
    // globally-registered span. Fall back to the global stack so spans started
    // via `startActiveSpan({ global: true })` act as parents for descendants
    // that run in unrelated async tasks.
    const asyncContext = this.findLatestValidContext(this.getContextStack());
    if (asyncContext !== undefined) {
      return asyncContext;
    }
    const globalContext = this.findLatestValidContext(this._globalActiveContexts);
    if (globalContext !== undefined) {
      return globalContext;
    }
    return ROOT_CONTEXT;
  }

  public static pushContext(context: Context) {
    const contexts = this.getContextStack();
    const newContexts = [...contexts, context];
    this._asyncLocalStorage.enterWith(newContexts);
  }

  public static popContext() {
    const contexts = this.getContextStack();
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

  public static pushGlobalContext(context: Context) {
    this._globalActiveContexts.push(context);
  }

  // Remove a specific context reference from the ALS stack. Unlike
  // `popContext`, this does not assume LIFO order — it locates the most
  // recent entry `=== context` and splices it out. Used by callers (e.g. the
  // OpenAI Agents processor) that activate spans so nested instrumentation
  // inherits them, but whose spans can end in arbitrary order with respect to
  // other activated spans on the same async frame.
  public static removeContext(context: Context) {
    const contexts = this.getContextStack();
    if (contexts.length === 0) {
      return;
    }
    for (let i = contexts.length - 1; i >= 0; i--) {
      if (contexts[i] === context) {
        const newContexts = contexts.slice(0, i).concat(contexts.slice(i + 1));
        this._asyncLocalStorage.enterWith(newContexts);
        return;
      }
    }
  }

  public static popGlobalContext(context?: Context) {
    if (context !== undefined) {
      // Remove the specific context entry (most recent occurrence) to keep
      // the stack consistent when spans end out of order across async tasks.
      for (let i = this._globalActiveContexts.length - 1; i >= 0; i--) {
        if (this._globalActiveContexts[i] === context) {
          this._globalActiveContexts.splice(i, 1);
          return;
        }
      }
      return;
    }
    if (this._globalActiveContexts.length > 0) {
      this._globalActiveContexts.pop();
    }
  }

  public static clearContexts() {
    this._asyncLocalStorage.enterWith([]);
    this._globalActiveContexts = [];
  }

  public static clearActiveSpans() {
    this._activeSpans.clear();
  }

  public static getContextStack(): Context[] {
    return this._asyncLocalStorage.getStore()
      || (this._inheritGlobalContext ? [contextApi.active()] : []);
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

  public static setAssociationProperties(span: LaminarSpan, context: Context): Context {
    const properties = span.laminarAssociationProperties;

    return this.setRawAssociationProperties(properties, context);
  }

  public static setRawAssociationProperties(
    properties: Record<string, any>,
    context: Context,
  ): Context {
    let entityContext = context;
    const userId = properties.userId;
    const sessionId = properties.sessionId;
    const rolloutSessionId = properties.rolloutSessionId;
    const traceType = properties.traceType;
    const metadata = properties.metadata;
    const tracingLevel = properties.tracingLevel;
    entityContext = entityContext.setValue(ASSOCIATION_PROPERTIES_KEY, {
      userId,
      sessionId,
      traceType,
      metadata,
      tracingLevel,
      rolloutSessionId,
    });
    return entityContext;
  }

  public static setGlobalMetadata(globalMetadata: Record<string, any>) {
    this._globalMetadata = globalMetadata;
  }

  public static getGlobalMetadata(): Record<string, any> {
    return this._globalMetadata;
  }

  public static getAssociationProperties(): {
    userId?: string;
    sessionId?: string;
    rolloutSessionId?: string;
    traceType?: TraceType;
    tracingLevel?: TracingLevel;
    metadata?: Record<string, any>;
  } {
    const entityContext = this.getContext();
    return entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};
  }

  public static set inheritGlobalContext(inheritGlobalContext: boolean) {
    this._inheritGlobalContext = inheritGlobalContext;
  }
}
