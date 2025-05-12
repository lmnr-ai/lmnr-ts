import type * as StagehandLib from "@browserbasehq/stagehand";
import { ActOptions, LLMClient, Page as StagehandPage } from "@browserbasehq/stagehand";
import { diag, Span } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import { z } from "zod";

import { version as SDK_VERSION } from "../../package.json";
import { observe as laminarObserve } from "../decorators";
import { Laminar } from "../laminar";
import { PlaywrightInstrumentation } from "./playwright";
import { cleanStagehandLLMClient, prettyPrintZodSchema } from "./utils";

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
export class StagehandInstrumentation extends InstrumentationBase {
  private playwrightInstrumentation: PlaywrightInstrumentation;
  private _parentSpan: Span | undefined;

  constructor(playwrightInstrumentation: PlaywrightInstrumentation) {
    super(
      "@lmnr/browserbase-stagehand-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
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
    diag.debug(`patching stagehand ${moduleVersion}`);
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
        },
      });
    } else {
      // If it's configurable, use the standard _wrap method
      this._wrap(
        moduleExports,
        'Stagehand',
        this.patchStagehandConstructor(),
      );

      return moduleExports;
    }
  }

  public manuallyInstrument(Stagehand: typeof StagehandLib.Stagehand) {
    diag.debug('manually instrumenting stagehand');

    // Since we can't replace the Stagehand constructor directly due to non-configurable property,
    // we'll patch the prototype methods of the existing constructor

    // First, patch the init method on the prototype
    if (Stagehand && Stagehand.prototype) {
      this._wrap(
        Stagehand.prototype,
        'init',
        this.patchStagehandInit(),
      );
      this._wrap(
        Stagehand.prototype,
        'close',
        this.patchStagehandClose(),
      );
    }
  }

  private unpatch(moduleExports: typeof StagehandLib, moduleVersion?: string) {
    diag.debug(`unpatching stagehand ${moduleVersion}`);
    this._unwrap(moduleExports, 'Stagehand');

    if (moduleExports.Stagehand) {
      this._unwrap(moduleExports.Stagehand.prototype, 'init');
      this._unwrap(moduleExports.Stagehand.prototype, 'close');
      if (moduleExports.Stagehand.prototype?.page) {
        this._unwrap(moduleExports.Stagehand.prototype.page, 'act');
        this._unwrap(moduleExports.Stagehand.prototype.page, 'extract');
        this._unwrap(moduleExports.Stagehand.prototype.page, 'observe');
        const observeHandler = (moduleExports.Stagehand.prototype.page as any).observeHandler;
        if (observeHandler) {
          this._unwrap(observeHandler, 'observe');
        }
        const extractHandler = (moduleExports.Stagehand.prototype.page as any).extractHandler;
        if (extractHandler) {
          this._unwrap(extractHandler, 'textExtract');
          this._unwrap(extractHandler, 'domExtract');
        }
        const actHandler = (moduleExports.Stagehand.prototype.page as any).actHandler;
        if (actHandler) {
          this._unwrap(actHandler, 'act');
        }
      }
    }

    return moduleExports;
  }

  private patchStagehandConstructor() {
    const instrumentation = this;

    return (Original: typeof StagehandLib.Stagehand) => {
      // Create a constructor function that maintains the same signature
      const Stagehand = function (this: InstanceType<typeof Original>, ...args: any[]) {
        // Only apply if this is a new instance
        if (!(this instanceof Stagehand)) {
          return new (Stagehand as any)(...args);
        }

        const instance = new Original(args.length > 0 ? args[0] : undefined);
        Object.assign(this, instance);

        instrumentation._wrap(
          this,
          'init',
          instrumentation.patchStagehandInit(),
        );

        instrumentation._wrap(
          this,
          'close',
          instrumentation.patchStagehandClose(),
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

    return (original: Function) => async function method(this: any, ...args: any[]) {
      // Make sure the parent span is set before calling the original init method
      // so that playwright instrumentation does not set its default parent span
      instrumentation._parentSpan = Laminar.startSpan({
        name: 'Stagehand',
      });
      instrumentation.playwrightInstrumentation.setParentSpan(instrumentation._parentSpan);

      const result = await original.bind(this).apply(this, args);

      await instrumentation.playwrightInstrumentation.patchPage(this.page);
      instrumentation.patchStagehandPage(this.stagehandPage);
      return result;
    };
  }

  private patchStagehandClose() {
    const instrumentation = this;
    return (original: Function) => async function method(this: any, ...args: any[]) {
      if (instrumentation._parentSpan && instrumentation._parentSpan.isRecording()) {
        instrumentation._parentSpan.end();
      }
      await original.bind(this).apply(this, args);
    };
  }

  private patchStagehandPage(page: StagehandPage) {
    const actHandler = (page as any).actHandler;
    if (actHandler) {
      if (actHandler.act) {
        this._wrap(
          actHandler,
          'act',
          this.patchStagehandV1ActHandlerAct(),
        );
      }
      if (actHandler.actFromObserveResult) {
        this._wrap(
          actHandler,
          'actFromObserveResult',
          this.patchStagehandV2ActHandlerActFromObserveResult(),
        );
      }
      if (actHandler.observeAct) {
        this._wrap(
          actHandler,
          'observeAct',
          this.patchStagehandV2ActHandlerObserveAct(),
        );
      }
    }

    const observeHandler = (page as any).observeHandler;
    if (observeHandler) {
      this._wrap(
        observeHandler,
        'observe',
        this.patchStagehandObserveHandler(),
      );
    }

    const extractHandler = (page as any).extractHandler;
    if (extractHandler) {
      this._wrap(
        extractHandler,
        'textExtract',
        this.patchStagehandExtractHandlerTextExtract(),
      );

      this._wrap(
        extractHandler,
        'domExtract',
        this.patchStagehandExtractHandlerDomExtract(),
      );
    }

    this._wrap(
      page,
      'act',
      this.patchStagehandGlobalMethod('act'),
    );

    this._wrap(
      page,
      'extract',
      this.patchStagehandGlobalMethod('extract'),
    );

    this._wrap(
      page,
      'observe',
      this.patchStagehandGlobalMethod('observe'),
    );
  }

  private patchStagehandGlobalMethod(methodName: string) {
    const instrumentation = this;
    return (original: (...args: any[]) => Promise<any>) =>
      async function method(this: any, ...args: any[]) {
        return await Laminar.withSpan(instrumentation._parentSpan!, async () =>
          await laminarObserve(
            { name: `stagehand.${methodName}`, input: args },
            async (thisArg, ...rest) => await original.apply(thisArg, ...rest),
            this, args,
          ),
        );
      };
  }

  private patchStagehandV1ActHandlerAct() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function act(this: any, ...args: any[]) {
        return await laminarObserve(
          {
            name: 'stagehand.actHandler.act',
            input: {
              action: args[0].action,
              llmClient: cleanStagehandLLMClient(args[0].llmClient ?? {}),
              chunksSeen: args[0].chunksSeen,
              steps: args[0].steps,
              requestId: args[0].requestId,
              schema: args[0].schema,
              retries: args[0].retries,
              variables: args[0].variables,
              previousSelectors: args[0].previousSelectors,
              skipActionCacheForThisStep: args[0].skipActionCacheForThisStep,
              domSettleTimeoutMs: args[0].domSettleTimeoutMs,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchStagehandV2ActHandlerActFromObserveResult() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function act(this: any, ...args: any[]) {
        return await laminarObserve(
          {
            name: 'stagehand.actHandler.actFromObserveResult',
            input: {
              observe: args?.[0] ?? null,
              domSettleTimeoutMs: args?.[1] ?? null,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchStagehandV2ActHandlerObserveAct() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function act(this: any, ...args: any[]) {
        const actOptions = args?.[0] as ActOptions | undefined;
        const llmClient = args.filter((arg) =>
          Object.keys(arg).includes('modelName'),
        )[0] as LLMClient | undefined;
        const requestId = typeof args?.[3] === 'string' ? args?.[3] : null;
        return await laminarObserve(
          {
            name: 'stagehand.actHandler.observeAct',
            input: {
              action: actOptions?.action,
              modelName: actOptions?.modelName,
              variables: actOptions?.variables,
              domSettleTimeoutMs: actOptions?.domSettleTimeoutMs,
              timeoutMs: actOptions?.timeoutMs,
              llmClient: cleanStagehandLLMClient(llmClient ?? {}),
              requestId: requestId,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchStagehandExtractHandlerTextExtract() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function textExtract(this: any, ...args: any[]) {
        const schema = (args[0].schema as z.AnyZodObject);
        let prettySchema = schema?.shape;
        try {
          prettySchema = prettyPrintZodSchema(schema);
        } catch (error) {
          diag.warn('Error pretty printing zod schema', { error });
        }
        return await laminarObserve(
          {
            name: 'stagehand.extractHandler.textExtract',
            input: {
              instruction: args[0].instruction,
              llmClient: cleanStagehandLLMClient(args[0].llmClient ?? {}),
              requestId: args[0].requestId,
              schema: prettySchema,
              content: args[0].content,
              domSettleTimeoutMs: args[0].domSettleTimeoutMs,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }

  private patchStagehandExtractHandlerDomExtract() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function domExtract(this: any, ...args: any[]) {
        const schema = (args[0].schema as z.AnyZodObject);
        let prettySchema = schema?.shape;
        try {
          prettySchema = prettyPrintZodSchema(schema);
        } catch (error) {
          diag.warn('Error pretty printing zod schema', { error });
        }

        return await laminarObserve(
          {
            name: 'stagehand.extractHandler.domExtract',
            input: {
              instruction: args[0].instruction,
              llmClient: cleanStagehandLLMClient(args[0].llmClient ?? {}),
              requestId: args[0].requestId,
              schema: prettySchema,
              content: args[0].content,
              chunksSeen: args[0].chunksSeen,
              domSettleTimeoutMs: args[0].domSettleTimeoutMs,
            },
          },
          async () => await original.apply(this, args),
        );
      };
  }

  private patchStagehandObserveHandler() {
    return (original: (...args: any[]) => Promise<any>) =>
      async function observe(this: any, ...args: any[]) {

        return await laminarObserve(
          {
            name: 'stagehand.observeHandler.observe',
            input: {
              instruction: args[0].instruction,
              llmClient: cleanStagehandLLMClient(args[0].llmClient ?? {}),
              requestId: args[0].requestId,
              returnAction: args[0].returnAction,
              onlyVisible: args[0].onlyVisible,
              drawOverlay: args[0].drawOverlay,
            },
          },
          async () => await original.bind(this).apply(this, args),
        );
      };
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
