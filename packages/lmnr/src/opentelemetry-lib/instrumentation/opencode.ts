// biome-ignore-all lint/complexity/noBannedTypes: instrumentation wraps arbitrary Functions
import { diag } from "@opentelemetry/api";

import { Laminar } from "../../laminar";
import { InstrumentedModule, LaminarInstrumentation } from "./shared/base";

export class OpencodeInstrumentation extends LaminarInstrumentation {
  constructor() {
    super("opencode");
  }

  /**
   * Manual instrumentation accepts the `OpencodeClient` class or the module
   * object.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@opencode-ai/sdk",
        supportedVersions: [">=1.0.0"],
        patch: (moduleExports) => {
          const SessionClass = this.resolveSessionClass(moduleExports);
          if (SessionClass) this.patchSessionClass(SessionClass);
        },
        unpatch: (moduleExports) => {
          const SessionClass = this.resolveSessionClass(moduleExports);
          if (!SessionClass) return;
          this.unwrapMethod(SessionClass.prototype, "prompt");
          this.unwrapMethod(SessionClass.prototype, "promptAsync");
        },
        accepts: (input) =>
          Boolean(input?.OpencodeClient) || typeof input === "function",
      },
    ];
  }

  private patchSessionClass(SessionClass: Function): void {
    for (const method of ["prompt", "promptAsync"]) {
      this.wrapMethod(SessionClass.prototype, method, ({ original }) =>
        wrapPrompt(original),
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
}

const wrapPrompt = (
  original: (...args: any[]) => any,
): ((...args: any[]) => any) =>
  function (this: any, ...args: any[]) {
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
      } else {
        diag.debug(
          "OpencodeInstrumentation: no active Laminar span context to " +
            "propagate. Opencode-side spans will start a new trace " +
            "instead of being children of the caller's span.",
        );
      }
    }
    return original.apply(this, args);
  };
