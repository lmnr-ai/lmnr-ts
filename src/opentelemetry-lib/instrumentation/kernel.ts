import type * as KernelSDK from "@onkernel/sdk";
import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../package.json";
import { observe } from "../../decorators";
import { Laminar } from "../../laminar";

const WRAPPED_BROWSER_METHODS: (keyof KernelSDK.Kernel.Browsers)[] = [
  'create',
  'retrieve',
  'list',
  'delete',
  'deleteByID',
  'loadExtensions',
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

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type
*/
export class KernelInstrumentation extends InstrumentationBase {
  constructor() {
    super(
      "@lmnr/kernel-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
    );
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@onkernel/sdk",
      ['>=0.7.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  public manuallyInstrument(kernelModule: typeof KernelSDK) {
    // Instrument resource classes
    for (const wrappedMethod of WRAPPED_BROWSER_METHODS) {
      this._wrap(
        kernelModule.Kernel.Browsers.prototype,
        wrappedMethod,
        this.patchMethod('Browser', wrappedMethod, 'DEFAULT'),
      );
    }
    for (const wrappedMethod of WRAPPED_COMPUTER_METHODS) {
      if (wrappedMethod === 'captureScreenshot') {
        this._wrap(
          kernelModule.Kernel.Browsers.Computer.prototype,
          wrappedMethod,
          this.patchTakeScreenshot(),
        );
      } else {
        this._wrap(
          kernelModule.Kernel.Browsers.Computer.prototype,
          wrappedMethod,
          this.patchMethod('Computer', wrappedMethod, 'TOOL'),
        );
      }
    }
    for (const wrappedMethod of WRAPPED_PROCESS_METHODS) {
      this._wrap(
        kernelModule.Kernel.Browsers.Process.prototype,
        wrappedMethod,
        this.patchProcessMethod(wrappedMethod),
      );
    }

    // Wrap the Kernel.app() factory method to patch KernelApp.action()
    this._wrap(
      kernelModule.Kernel.prototype,
      'app',
      this.patchAppFactory(),
    );
  }

  private patchMethod(className: string, method: string, spanType: 'DEFAULT' | 'TOOL'): any {
    const plugin = this;
    return (original: (...args: any[]) => KernelSDK.APIPromise<unknown>) =>
      async function (this: any, ...args: any[]) {
        // Use observe() to automatically handle span lifecycle, input/output capture, and errors
        return await observe(
          {
            name: `${className}.${method}`,
            spanType,
            input: plugin.formatInput(args),
          },
          async (innerArgs: any[]) =>
            await (original.bind(this).apply(this, innerArgs)),
          args,
        );
      };
  }

  private patchTakeScreenshot(): any {
    const plugin = this;
    return (original: (...args: any[]) => KernelSDK.APIPromise<unknown>) =>
      async function (this: any, ...args: any[]) {
        // Use observe() to automatically handle span lifecycle, input/output capture, and errors
        const span = Laminar.startSpan({
          name: `Computer.captureScreenshot`,
          spanType: 'TOOL',
          input: plugin.formatInput(args),
        });
        try {
          const res = await original.bind(this).apply(this, args) as KernelSDK.APIPromise<unknown>;
          // We could actually parse binary and decode here, but we would need to consume
          // the api response byte stream, which may break the subsequent operations
          // on the response.
          span.setAttribute('lmnr.span.output', '<BASE64_ENCODED_IMAGE>');
          return res;
        } finally {
          span.end();
        }
      };
  }

  private patchProcessMethod(method: string): any {
    const plugin = this;
    return (original: (...args: any[]) => KernelSDK.APIPromise<unknown>) =>
      async function (this: any, ...args: any[]) {
        // First parameter of spawn and exec is the session ID, for others its PID (string)
        const input = ['spawn', 'exec'].includes(method) ? plugin.formatInput(args) : plugin.formatProcessInput(args);
        const span = Laminar.startSpan({
          name: `Process.${method}`,
          spanType: 'TOOL',
          input,
        });
        try {
          const result = await (original.bind(this).apply(this, args) as KernelSDK.APIPromise<{
            stderr_b64?: string,
            stdout_b64?: string,
          }>);
          const output = {
            ...(
              result?.stderr_b64
                ? { stderr: Buffer.from(result.stderr_b64, 'base64').toString('utf-8') }
                : {}
            ),
            ...(
              result?.stdout_b64
                ? { stdout: Buffer.from(result.stdout_b64, 'base64').toString('utf-8') }
                : {}),
            ...result,
          };
          span.setAttribute('lmnr.span.output', JSON.stringify(output));
          return result;
        } finally {
          span.end();
        }
      };
  }


  private patchAppFactory() {
    const plugin = this;
    return (original: Function) => function (this: any, name: string): any {
      // Call the original app() method to get the KernelApp instance
      const kernelApp = original.call(this, name);

      // Patch the action method on the returned KernelApp instance
      plugin._wrap(
        kernelApp,
        'action',
        plugin.patchKernelAppAction(),
      );

      return kernelApp;
    };
  }

  private patchKernelAppAction() {
    return (original: any) => function (this: any, name: string, handler: Function): any {
      // Wrap the handler with observe
      const wrappedHandler = async (context: any, payload?: any) => {
        const result = await observe(
          {
            name: `action.${name}`,
            spanType: 'DEFAULT',
          },
          async (innerCtx: any, innerPayload: any) => {
            const result = await handler(innerCtx, innerPayload);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return result;
          },
          context,
          payload,
        );
        await Laminar.flush();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return result;
      };

      // Register the wrapped handler with the original action method
      return original.call(this, name, wrappedHandler);
    };
  }

  private formatInput(args: unknown[]): [{ sessionId: string }, ...unknown[]] | unknown[] {
    if (args.length === 0) {
      return []
    }
    if (typeof args[0] === "string") {
      return [{ sessionId: args[0] }, ...args.slice(1)];
    }
    return args;
  }

  private formatProcessInput(args: unknown[]): [{ sessionId: string, processID: string }, ...unknown[]] | unknown[] {
    if (args.length === 0) {
      return []
    }
    if (typeof args[0] === "string") {
      if (args.length === 1) {
        return [{ processID: args[0] }];
      }
      const requestParams = args[1] as { id?: string };
      if (requestParams.id) {
        return [{ processID: args[0], sessionId: requestParams.id }, ...args.slice(1)];
      }
      return [{ processID: args[0] }, ...args.slice(1)];
    }
    return args;
  }

  private patch(moduleExports: typeof KernelSDK): any {
    diag.debug('Patching @onkernel/sdk');
    this.manuallyInstrument(moduleExports);
    return moduleExports;
  }

  private unpatch(moduleExports: typeof KernelSDK): void {
    diag.debug('Unpatching @onkernel/sdk');

    // Unwrap resource classes
    for (const wrappedMethod of WRAPPED_BROWSER_METHODS) {
      this._unwrap(moduleExports.Kernel.Browsers.prototype, wrappedMethod);
    }
    for (const wrappedMethod of WRAPPED_COMPUTER_METHODS) {
      this._unwrap(moduleExports.Kernel.Browsers.Computer.prototype, wrappedMethod);
    }
    for (const wrappedMethod of WRAPPED_PROCESS_METHODS) {
      this._unwrap(moduleExports.Kernel.Browsers.Process.prototype, wrappedMethod);
    }

    // Unwrap Kernel.app
    this._unwrap(moduleExports.Kernel.prototype, 'app');
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type
*/
