import { diag, Span, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import type * as ComputerLib from "@trycua/computer";

import { version as SDK_VERSION } from "../../../package.json";
import { observe } from '../../decorators';
import { Laminar } from '../../laminar';
import { initializeLogger } from '../../utils';
import { LaminarContextManager } from '../tracing/context';
import { LaminarSpan } from '../tracing/span';

const logger = initializeLogger();

interface ComputerInterfaceMethodParam {
  name: string;
  optional: boolean;
}

interface ComputerInterfaceMethodDefinition {
  params: ComputerInterfaceMethodParam[];
  sync?: boolean;
  ignoreOutput?: boolean;
}

const PATCH_COMPUTER_INTERFACE_METHODS: Record<string, ComputerInterfaceMethodDefinition> = {
  connect: {
    params: [],
  },
  sendCommand: {
    params: [{ name: 'command', optional: false }, { name: 'params', optional: false }]
  },
  isConnected: {
    params: [],
    sync: true,
  },
  disconnect: {
    params: [],
  },
  forceClose: {
    params: [],
    sync: true,
  },
  mouseDown: {
    params: [
      { name: 'x', optional: true },
      { name: 'y', optional: true },
      { name: 'button', optional: true },
    ]
  },
  mouseUp: {
    params: [
      { name: 'x', optional: true },
      { name: 'y', optional: true },
      { name: 'button', optional: true },
    ]
  },
  leftClick: {
    params: [{ name: 'x', optional: true }, { name: 'y', optional: true }]
  },
  rightClick: {
    params: [{ name: 'x', optional: true }, { name: 'y', optional: true }]
  },
  doubleClick: {
    params: [{ name: 'x', optional: true }, { name: 'y', optional: true }]
  },
  moveCursor: {
    params: [{ name: 'x', optional: false }, { name: 'y', optional: false }]
  },
  dragTo: {
    params: [
      { name: 'x', optional: false },
      { name: 'y', optional: false },
      { name: 'button', optional: true },
      { name: 'duration', optional: true },
    ]
  },
  drag: {
    params: [
      { name: 'params', optional: false },
      { name: 'button', optional: true },
      { name: 'duration', optional: true },
    ]
  },
  keyDown: {
    params: [{ name: 'key', optional: false }]
  },
  keyUp: {
    params: [{ name: 'key', optional: false }]
  },
  typeText: {
    params: [{ name: 'text', optional: false }]
  },
  pressKey: {
    params: [{ name: 'key', optional: false }]
  },
  hotkey: {
    params: [{ name: 'keys', optional: false }]
  },
  scroll: {
    params: [{ name: 'x', optional: false }, { name: 'y', optional: false }]
  },
  scrollDown: {
    params: [{ name: 'clicks', optional: true }]
  },
  scrollUp: {
    params: [{ name: 'clicks', optional: true }]
  },
  screenshot: {
    params: [],
    ignoreOutput: true,
  },
  getScreenSize: {
    params: [],
  },
  getCursorPosition: {
    params: [],
  },
  copyToClipboard: {
    params: [],
  },
  setClipboard: {
    params: [{ name: 'text', optional: false }],
  },
  fileExists: {
    params: [{ name: 'path', optional: false }],
  },
  directoryExists: {
    params: [{ name: 'path', optional: false }],
  },
  listDir: {
    params: [{ name: 'path', optional: false }],
  },
  readText: {
    params: [{ name: 'path', optional: false }],
  },
  writeText: {
    params: [{ name: 'path', optional: false }, { name: 'content', optional: false }],
  },
  readBytes: {
    params: [{ name: 'path', optional: false }],
  },
  writeBytes: {
    params: [{ name: 'path', optional: false }, { name: 'content', optional: false }],
  },
  deleteFile: {
    params: [{ name: 'path', optional: false }],
  },
  deleteDir: {
    params: [{ name: 'path', optional: false }],
  },
  runCommand: {
    params: [{ name: 'command', optional: false }],
  },
  getAccessibilityTree: {
    params: [],
  },
  toScreenCoordinates: {
    params: [{ name: "x", optional: false }, { name: "y", optional: false }],
  },
  toScreenshotCoordinates: {
    params: [{ name: "x", optional: false }, { name: "y", optional: false }],
  },
};


/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
export class CuaComputerInstrumentation extends InstrumentationBase {
  // object extends ComputerLib.BaseComputerInterface
  // it is not exported as of writing the instrumentation.
  // https://github.com/trycua/cua/blob/6401c12812551ff9d5851e19f9a9d4f4b4b78d2f/libs/typescript/computer/src/index.ts#L4
  private parentSpans: WeakMap<object, Span> = new WeakMap();

  constructor() {
    super("@lmnr/cua-computer-instrumentation", SDK_VERSION, {
      enabled: true,
    });
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@trycua/computer",
      ['>=0.1.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  public manuallyInstrument(Computer: typeof ComputerLib.Computer) {
    if (Computer && Computer.prototype) {
      this._wrap(
        Computer.prototype,
        'run',
        this.patchComputerRun(),
      );
      this._wrap(
        Computer.prototype,
        'stop',
        this.patchComputerStop(),
      );
    }
  }

  private patch(moduleExports: typeof ComputerLib, moduleVersion?: string) {
    diag.debug(`patching @trycua/computer ${moduleVersion}`);
    const descriptor = Object.getOwnPropertyDescriptor(moduleExports, 'Computer');
    if (descriptor && !descriptor.configurable) {
      const originalComputer = moduleExports.Computer;
      const patchedConstructor = this.patchComputerConstructor()(originalComputer);
      return new Proxy(moduleExports, {
        get: (target, prop) => {
          if (prop === 'Computer') {
            return patchedConstructor;
          }
          return target[prop as keyof typeof target];
        },
      });
    } else {
      this._wrap(moduleExports, 'Computer', this.patchComputerConstructor());
    }

    return moduleExports;
  }

  private patchComputerConstructor() {
    const instrumentation = this;

    return (Original: typeof ComputerLib.Computer) => {
      const Computer = function (this: InstanceType<typeof Original>, ...args: any[]) {
        if (!(this instanceof Computer)) {
          return new (Computer as any)(...args);
        }

        const instance = new Original(args.length > 0 ? args[0] : undefined);
        Object.assign(this, instance);

        instrumentation._wrap(
          this,
          'run',
          instrumentation.patchComputerRun(),
        );

        instrumentation._wrap(
          this,
          'stop',
          instrumentation.patchComputerStop(),
        );

        return this;
      } as unknown as typeof Original;

      Object.setPrototypeOf(Computer, Original);
      Computer.prototype = Object.create(Original.prototype);
      Computer.prototype.constructor = Computer;

      return Computer;
    };
  }

  private unpatch(moduleExports: typeof ComputerLib, moduleVersion?: string) {
    diag.debug(`unpatching @trycua/computer ${moduleVersion}`);
    const computer = moduleExports.Computer;
    if (computer) {
      this._unwrap(computer.prototype, 'run');
      this._unwrap(computer.prototype, 'stop');
    }
  }

  private patchComputerRun() {
    const instrumentation = this;
    return (original: Function) => async function method(this: any, ...args: any[]) {
      const parentSpan = Laminar.startSpan({
        name: 'Computer.run',
      });
      const result = await original.bind(this).apply(this, args);
      const iface = this.interface;
      if (iface) {
        instrumentation.parentSpans.set(iface, parentSpan);
        instrumentation.patchComputerInterface(iface);
      }
      return result;
    };
  }

  // iface is of type ComputerLib.BaseComputerInterface, but the type is not exported
  private patchComputerInterface(iface: any) {
    for (const methodName in PATCH_COMPUTER_INTERFACE_METHODS) {
      if (iface[methodName]) {
        this._wrap(
          iface,
          methodName,
          this.patchComputerInterfaceMethod(methodName, PATCH_COMPUTER_INTERFACE_METHODS[methodName]),
        );
      }
    }
  }

  private patchComputerInterfaceMethod(methodName: string, definition: ComputerInterfaceMethodDefinition) {
    const instrumentation = this;
    return (original: Function) => async function method(this: any, ...args: any[]) {
      let input: Record<string, any> = {};
      let i = 0;
      for (const arg of args) {
        try {
          input[definition.params[i].name] = arg;
        } catch (error) {
          logger.debug(`Failed to add argument ${definition.params[i].name} to input: ${error}`);
        }
        i++;
      }
      const currentSpan = trace.getSpan(LaminarContextManager.getContext())
      let parentSpan: Span | undefined;

      if (currentSpan && (currentSpan as LaminarSpan).attributes["lmnr.cua.span.type"] === "interface") {
        parentSpan = currentSpan;
      } else {
        parentSpan = instrumentation.parentSpans.get(this);
      }
      const wrapper = parentSpan ? async (f: () => Promise<any>) => Laminar.withSpan(parentSpan, f) : async (f: () => Promise<any>) => await f();
      return wrapper(async () => await observe({
        name: `interface.${methodName}`,
        spanType: "TOOL",
        input,
        ignoreOutput: definition.ignoreOutput,
      }, async () => {
        // This is a hack to make sure nested spans nest in each other, not directly under the parent span
        // TODO: think about a better way to do this
        Laminar.setSpanAttributes({
          "lmnr.cua.span.type": "interface",
        })
        const result = definition.sync
          ? original.bind(this).apply(this, args)
          : await original.bind(this).apply(this, args);
        return result;
      }));
    }
  }

  private patchComputerStop() {
    const instrumentation = this;
    return (original: Function) => async function method(this: any, ...args: any[]) {
      const iface = this.interface;
      const parentSpan = instrumentation.parentSpans.get(iface);
      const result = await original.bind(this).apply(this, args);
      if (parentSpan) {
        parentSpan.end();
      }
      instrumentation.parentSpans.delete(iface);
      return result;
    };
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
