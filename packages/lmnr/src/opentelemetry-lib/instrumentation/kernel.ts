// biome-ignore-all lint/complexity/noBannedTypes: instrumentation wraps arbitrary Functions
import type * as KernelSDK from "@onkernel/sdk";

import { Laminar } from "../../laminar";
import {
  InstrumentedModule,
  instrumentedObserve,
  LaminarInstrumentation,
  PatchedMethod,
} from "./shared/base";

const KERNEL = "@onkernel/sdk";

const observe = instrumentedObserve(KERNEL);

const WRAPPED_BROWSER_METHODS: (keyof KernelSDK.Kernel.Browsers)[] = [
  "create",
  "retrieve",
  "list",
  "deleteByID",
  "loadExtensions",
];

const WRAPPED_COMPUTER_METHODS: (keyof KernelSDK.Kernel.Browsers.Computer)[] = [
  "captureScreenshot",
  "clickMouse",
  "dragMouse",
  "moveMouse",
  "pressKey",
  "scroll",
  "typeText",
];

const WRAPPED_PROCESS_METHODS: (keyof KernelSDK.Kernel.Browsers.Process)[] = [
  "exec",
  "kill",
  "spawn",
  "status",
  "stdin",
  "stdoutStream",
];

export class KernelInstrumentation extends LaminarInstrumentation {
  constructor() {
    super("kernel");
  }

  protected modules(): InstrumentedModule[] {
    return [
      {
        name: KERNEL,
        supportedVersions: [">=0.7.0"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) => this.unpatch(moduleExports),
        accepts: (input) => typeof input?.Kernel?.Browsers === "function",
      },
    ];
  }

  private patch(kernelModule: typeof KernelSDK): void {
    // Instrument resource classes
    for (const wrappedMethod of WRAPPED_BROWSER_METHODS) {
      this.wrapMethod(
        kernelModule.Kernel.Browsers.prototype,
        wrappedMethod,
        (patched) =>
          this.patchMethod(patched, "Browser", wrappedMethod, "DEFAULT"),
      );
    }
    for (const wrappedMethod of WRAPPED_COMPUTER_METHODS) {
      this.wrapMethod(
        kernelModule.Kernel.Browsers.Computer.prototype,
        wrappedMethod,
        wrappedMethod === "captureScreenshot"
          ? (patched) => this.patchTakeScreenshot(patched)
          : (patched) =>
              this.patchMethod(patched, "Computer", wrappedMethod, "TOOL"),
      );
    }
    for (const wrappedMethod of WRAPPED_PROCESS_METHODS) {
      this.wrapMethod(
        kernelModule.Kernel.Browsers.Process.prototype,
        wrappedMethod,
        (patched) => this.patchProcessMethod(patched, wrappedMethod),
      );
    }

    // Wrap the Kernel.app() factory method to patch KernelApp.action()
    this.wrapMethod(kernelModule.Kernel.prototype, "app", (patched) =>
      this.patchAppFactory(patched),
    );
  }

  private unpatch(moduleExports: typeof KernelSDK): void {
    // Unwrap resource classes
    for (const wrappedMethod of WRAPPED_BROWSER_METHODS) {
      this.unwrapMethod(moduleExports.Kernel.Browsers.prototype, wrappedMethod);
    }
    for (const wrappedMethod of WRAPPED_COMPUTER_METHODS) {
      this.unwrapMethod(
        moduleExports.Kernel.Browsers.Computer.prototype,
        wrappedMethod,
      );
    }
    for (const wrappedMethod of WRAPPED_PROCESS_METHODS) {
      this.unwrapMethod(
        moduleExports.Kernel.Browsers.Process.prototype,
        wrappedMethod,
      );
    }

    // Unwrap Kernel.app
    this.unwrapMethod(moduleExports.Kernel.prototype, "app");
  }

  private patchMethod(
    { original }: PatchedMethod,
    className: string,
    method: string,
    spanType: "DEFAULT" | "TOOL",
  ) {
    const plugin = this;
    return async function (this: any, ...args: any[]) {
      // Use observe() to automatically handle span lifecycle, input/output capture, and errors
      return await observe(
        {
          name: `${className}.${method}`,
          spanType,
          input: plugin.formatInput(args),
        },
        async (innerArgs: any[]) =>
          await original.bind(this).apply(this, innerArgs),
        args,
      );
    };
  }

  private patchTakeScreenshot({ instrumentation, original }: PatchedMethod) {
    const plugin = this;
    return async function (this: any, ...args: any[]) {
      const span = instrumentation.startSpan({
        name: `Computer.captureScreenshot`,
        spanType: "TOOL",
        input: plugin.formatInput(args),
      });
      try {
        const res = (await original
          .bind(this)
          .apply(this, args)) as KernelSDK.APIPromise<unknown>;
        // We could actually parse binary and decode here, but we would need to consume
        // the api response byte stream, which may break the subsequent operations
        // on the response.
        span.setAttribute("lmnr.span.output", "<BASE64_ENCODED_IMAGE>");
        return res;
      } finally {
        span.end();
      }
    };
  }

  private patchProcessMethod(
    { instrumentation, original }: PatchedMethod,
    method: string,
  ) {
    const plugin = this;
    return async function (this: any, ...args: any[]) {
      // First parameter of spawn and exec is the session ID, for others its PID (string)
      const input = ["spawn", "exec"].includes(method)
        ? plugin.formatInput(args)
        : plugin.formatProcessInput(args);
      const span = instrumentation.startSpan({
        name: `Process.${method}`,
        spanType: "TOOL",
        input,
      });
      try {
        const result = await (original
          .bind(this)
          .apply(this, args) as KernelSDK.APIPromise<{
          stderr_b64?: string;
          stdout_b64?: string;
        }>);
        const output = {
          ...(result?.stderr_b64
            ? {
                stderr: Buffer.from(result.stderr_b64, "base64").toString(
                  "utf-8",
                ),
              }
            : {}),
          ...(result?.stdout_b64
            ? {
                stdout: Buffer.from(result.stdout_b64, "base64").toString(
                  "utf-8",
                ),
              }
            : {}),
          ...result,
        };
        span.setAttribute("lmnr.span.output", JSON.stringify(output));
        return result;
      } finally {
        span.end();
      }
    };
  }

  private patchAppFactory({ original }: PatchedMethod) {
    const plugin = this;
    return function (this: any, name: string): any {
      // Call the original app() method to get the KernelApp instance
      const kernelApp = original.call(this, name);

      // Patch the action method on the returned KernelApp instance
      plugin.wrapMethod(kernelApp, "action", (patched) =>
        plugin.patchKernelAppAction(patched),
      );

      return kernelApp;
    };
  }

  private patchKernelAppAction({ original }: PatchedMethod) {
    return function (this: any, name: string, handler: Function): any {
      // Wrap the handler with observe
      const wrappedHandler = async (context: any, payload?: any) => {
        const result = await observe(
          {
            name: `action.${name}`,
            spanType: "DEFAULT",
          },
          async (innerCtx: any, innerPayload: any) => {
            const result = await handler(innerCtx, innerPayload);
            return result;
          },
          context,
          payload,
        );
        await Laminar.flush();
        return result;
      };

      // Register the wrapped handler with the original action method
      return original.call(this, name, wrappedHandler);
    };
  }

  private formatInput(args: unknown[]): unknown[] {
    if (args.length === 0) {
      return [];
    }
    if (typeof args[0] === "string") {
      return [{ session_id: args[0] }, ...args.slice(1)];
    }
    return args;
  }

  private formatProcessInput(args: unknown[]): unknown[] {
    if (args.length === 0) {
      return [];
    }
    if (typeof args[0] === "string") {
      if (args.length === 1) {
        return [{ processID: args[0] }];
      }
      const requestParams = args[1] as { id?: string };
      if (requestParams.id) {
        return [
          { processID: args[0], session_id: requestParams.id },
          ...args.slice(1),
        ];
      }
      return [{ processID: args[0] }, ...args.slice(1)];
    }
    return args;
  }
}
