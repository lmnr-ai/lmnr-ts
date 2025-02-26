import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition
} from "@opentelemetry/instrumentation";
import { version as SDK_VERSION } from "../../package.json";
import { observe as laminarObserve } from "../decorators";
import { PlaywrightInstrumentation } from "./playwright";
import { Page as StagehandPage } from "@browserbasehq/stagehand";
import { Page, BrowserContext } from "playwright";
import type * as StagehandLib from "@browserbasehq/stagehand";
import { Span } from "@opentelemetry/api";
import { Laminar } from "../laminar";

export class StagehandInstrumentation extends InstrumentationBase {
  private playwrightInstrumentation: PlaywrightInstrumentation;
  
  constructor(playwrightInstrumentation: PlaywrightInstrumentation) {
    super(
      "@lmnr/browserbase-stagehand-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      }
    );
    this.playwrightInstrumentation = playwrightInstrumentation;
  }
  
  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@browserbasehq/stagehand",
      ['>=1.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  private patch(moduleExports: typeof StagehandLib, moduleVersion?: string) {
    // Check if Stagehand is non-configurable
    const descriptor = Object.getOwnPropertyDescriptor(moduleExports, 'Stagehand');    
    if (descriptor && !descriptor.configurable) {
      // Create a proxy for the entire module exports
      const originalStagehand = moduleExports.Stagehand;
      const patchedConstructor = this.patchStagehandConstructor()(originalStagehand);
      
      // Create a proxy for the module exports
      return new Proxy(moduleExports, {
        get: (target, prop) => {
          if (prop === 'Stagehand') {
            return patchedConstructor;
          }
          return target[prop as keyof typeof target];
        }
      });
    } else {
      // If it's configurable, use the standard _wrap method
      this._wrap(
        moduleExports,
        'Stagehand',
        this.patchStagehandConstructor()
      );
      
      return moduleExports;
    }
  }

  private unpatch(moduleExports: any, moduleVersion?: string) {
    this._unwrap(moduleExports, 'Stagehand');
    return moduleExports;
  }

  private patchStagehandConstructor() {
    const instrumentation = this;
    
    return (Original: typeof StagehandLib.Stagehand) => {
      // Create a constructor function that maintains the same signature
      const Stagehand = function(this: InstanceType<typeof Original>, ...args: any[]) {
        // Only apply if this is a new instance
        if (!(this instanceof Stagehand)) {
          return new (Stagehand as any)(...args);
        }
        
        const instance = new Original(args.length > 0 ? args[0] : undefined);
        Object.assign(this, instance);

        instrumentation._wrap(
          this,
          'init',
          instrumentation.patchStagehandInit()
        );

        return this;
      } as unknown as typeof Original;
      
      // Copy static properties
      Object.setPrototypeOf(Stagehand, Original);
      // Copy prototype properties
      Stagehand.prototype = Object.create(Original.prototype);
      Stagehand.prototype.constructor = Stagehand;
      
      return Stagehand;
    };
  }

  private patchStagehandInit() {
    const instrumentation = this;
    
    return (original: Function) => {
      return async function patchedInit(this: any, ...args: any[]) {
        // Call the original init method
        const result = await original.bind(this).apply(this, args);

        instrumentation._wrap(
          this,
          'close',
          instrumentation.patchStagehandClose()
        );

        await instrumentation.playwrightInstrumentation.patchPage(this.page);
        await instrumentation.patchStagehandPage(this.stagehandPage);

        return result;
      };
    };
  }

  private patchStagehandClose() {
    const instrumentation = this;
    return (original: Function) => {
      return async function patchedClose(this: any, ...args: any[]) {
        await original.bind(this).apply(this, args);
      };
    };
  }

  private async patchStagehandPage(page: StagehandPage) {
    this._wrap(
      page,
      'act',
      this.patchStagehandMethod('act')
    );

    this._wrap(
      page,
      'extract',
      this.patchStagehandMethod('extract')
    );

    this._wrap(
      page,
      'observe',
      this.patchStagehandMethod('observe')
    );
  }

  private patchStagehandMethod(method: string) {
    const instrumentation = this;
    return (original: (...args: any[]) => Promise<any>) => {
      return async function patchedMethod(this: any, ...args: any[]) {
        return await Laminar.withSpan(instrumentation.playwrightInstrumentation.parentSpan!, async () => 
          await laminarObserve(
            { name: `stagehand.${method}` },
            async (...args) => await original.apply(this, ...args),
            args
          )
        );
      };
    };
  }
}
