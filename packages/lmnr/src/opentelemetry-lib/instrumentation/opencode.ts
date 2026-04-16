import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../package.json";
import { Laminar } from "../../laminar";

/* eslint-disable
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-function-type
*/

export class OpencodeInstrumentation extends InstrumentationBase {
  constructor() {
    super("lmnr-opencode-instrumentation", SDK_VERSION, { enabled: true });
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@opencode-ai/sdk",
      [">=1.0.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(opencodeModule: any): void {
    diag.debug("Manually instrumenting @opencode-ai/sdk");
    const SessionClass = this.resolveSessionClass(opencodeModule);
    if (SessionClass) {
      this.patchSessionClass(SessionClass);
    } else {
      diag.warn(
        "Could not find Session class in opencode manual instrumentation input. " +
          "Pass the OpencodeClient class or the module object.",
      );
    }
  }

  private resolveSessionClass(input: any): any {
    // Module-level import: { OpencodeClient, ... }
    if (input?.OpencodeClient) {
      return this.getSessionClass(input.OpencodeClient);
    }
    // Direct class passed
    if (typeof input === "function" && input.prototype) {
      return this.getSessionClass(input);
    }
    return null;
  }

  // session is a class field on OpencodeClient (not on the prototype), so we
  // must instantiate to trigger field initialization and discover Session's constructor.
  private getSessionClass(ClientClass: any): Function | null {
    try {
      const instance = new ClientClass();
      if (instance.session) {
        return instance.session.constructor;
      }
    } catch {
      // fall through
    }
    return null;
  }

  private patchSessionClass(SessionClass: Function): void {
    this._wrap(SessionClass.prototype, "prompt", this.patchPromptMethod());
    this._wrap(SessionClass.prototype, "promptAsync", this.patchPromptMethod());
  }

  private patchPromptMethod(): (original: Function) => Function {
    return (original: Function) => {
      return function (this: any, ...args: any[]) {
        const options = args[0];
        if (options?.body?.parts && Array.isArray(options.body.parts)) {
          const serializedContext = Laminar.serializeLaminarSpanContext();
          if (serializedContext) {
            options.body.parts = [
              ...options.body.parts,
              {
                type: "text",
                metadata: {
                  lmnrSpanContext: serializedContext,
                },
                text: "",
                ignored: true,
                synthetic: true,
              },
            ];
          }
        }
        return original.apply(this, args);
      };
    };
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @opencode-ai/sdk");
    const SessionClass = this.resolveSessionClass(moduleExports);
    if (SessionClass) {
      this.patchSessionClass(SessionClass);
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @opencode-ai/sdk");
    const SessionClass = this.resolveSessionClass(moduleExports);
    if (SessionClass) {
      this._unwrap(SessionClass.prototype, "prompt");
      this._unwrap(SessionClass.prototype, "promptAsync");
    }
  }
}

/* eslint-enable
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-function-type
*/
