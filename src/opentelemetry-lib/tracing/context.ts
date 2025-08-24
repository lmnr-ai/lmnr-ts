import { Context, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";


export class LaminarContextManager {
  private static _asyncLocalStorage = new AsyncLocalStorage<Context[]>();

  public static getContext(): Context {
    const contexts = this._asyncLocalStorage.getStore() || [];
    return contexts[contexts.length - 1] || ROOT_CONTEXT;
  }

  public static pushContext(context: Context) {
    const contexts = this._asyncLocalStorage.getStore() || [];
    const newContexts = [...contexts, context];
    this._asyncLocalStorage.enterWith(newContexts);
  }

  public static popContext() {
    const contexts = this._asyncLocalStorage.getStore() || [];
    if (contexts.length > 0) {
      const newContexts = contexts.slice(0, -1);
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
