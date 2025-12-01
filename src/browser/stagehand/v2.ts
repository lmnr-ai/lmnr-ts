import { diag, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import { z } from "zod/v3";

import { version as SDK_VERSION } from "../../../package.json";
import { observe as laminarObserve } from "../../decorators";
import { Laminar } from "../../laminar";
import { LaminarContextManager } from "../../opentelemetry-lib/tracing/context";
import { newUUID, StringUUID } from "../../utils";
import { PlaywrightInstrumentation } from "../playwright";
import {
  cleanStagehandLLMClient,
  nameArgsOrCopy,
  prettyPrintZodSchema,
} from "../utils";
import { createLLMClientCreateChatCompletionWrapper } from "./shared-llm-wrapper";

// Stagehand interfaces:
type AvailableModel = string;

interface ActOptions {
  action: string;
  modelName?: AvailableModel;
  modelClientOptions?: any; // ClientOptions
  variables?: Record<string, string>;
  domSettleTimeoutMs?: number;
  timeoutMs?: number;
  iframes?: boolean;
  frameId?: string;
}
type LLMResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls: {
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }[];
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

interface ChatCompletionInnerOptions {
  messages: any[]; // ChatMessage[]
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  image?: {
    buffer: Buffer;
    description?: string;
  };
  response_model?: {
    name: string;
    schema: any; // ZodType
  };
  tools?: any[]; // LLMTool[]
  tool_choice?: "auto" | "none" | "required";
  maxTokens?: number;
  requestId?: string;
};

interface CreateChatCompletionOptions {
  options: ChatCompletionInnerOptions;
  logger: (message: any) => void;
  retries?: number;
}

declare abstract class LLMClient {
  type: "openai" | "anthropic" | "cerebras" | "groq" | (string & {});
  modelName: AvailableModel | (string & {});
  hasVision: boolean;
  clientOptions: any; // ClientOptions
  userProvidedInstructions?: string;
  constructor(modelName: AvailableModel, userProvidedInstructions?: string);
  abstract createChatCompletion<T = LLMResponse>(
    options: CreateChatCompletionOptions
  ): Promise<T>;
  generateText: (args: any) => Promise<any>;
  streamText: (args: any) => any;
  streamObject: (args: any) => any;
  generateImage: (args: any) => Promise<any>;
  embed: (args: any) => Promise<any>;
  embedMany: (args: any) => Promise<any>;
  transcribe: (args: any) => Promise<any>;
  generateSpeech: (args: any) => Promise<any>;
};

interface StagehandPage {
  act: (args: any) => Promise<any>;
  extract: (args: any) => Promise<any>;
  observe: (args: any) => Promise<any>;
  on: (args: any) => any;
}
// ================================


interface GlobalLLMClientOptions {
  // named `type` in Stagehand
  provider: "openai" | "anthropic" | "cerebras" | "groq" | (string & {})
  model: string
}

type AgentClient = {
  execute: (
    instructionOrOptions: string | object,
  ) => Promise<object>;
};

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
export class StagehandV2Instrumentation extends InstrumentationBase {
  private playwrightInstrumentation: PlaywrightInstrumentation;
  private globalLLMClientOptions: WeakMap<
    LLMClient,
    GlobalLLMClientOptions | undefined
  > = new WeakMap();
  private globalAgentOptions: WeakMap<
    object,
    Record<string, any> | undefined
  > = new WeakMap();
  private stagehandInstanceToSessionId: WeakMap<object, StringUUID> = new WeakMap();

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
      ['>=1.0.0 <3.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  private patch(moduleExports: any, moduleVersion?: string) {
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

  public manuallyInstrument(Stagehand: any) {
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

  private unpatch(moduleExports: any, moduleVersion?: string) {
    diag.debug(`unpatching stagehand ${moduleVersion}`);
    this._unwrap(moduleExports, 'Stagehand');

    if (moduleExports.Stagehand) {
      this._unwrap(moduleExports.Stagehand.prototype, 'init');
      this._unwrap(moduleExports.Stagehand.prototype, 'close');
      if (moduleExports.Stagehand.prototype?.page) {
        this._unwrap(moduleExports.Stagehand.prototype.page, 'act');
        this._unwrap(moduleExports.Stagehand.prototype.page, 'extract');
        this._unwrap(moduleExports.Stagehand.prototype.page, 'observe');
        const observeHandler = (moduleExports.Stagehand.prototype.page).observeHandler;
        if (observeHandler) {
          this._unwrap(observeHandler, 'observe');
        }
        const extractHandler = (moduleExports.Stagehand.prototype.page).extractHandler;
        if (extractHandler) {
          this._unwrap(extractHandler, 'textExtract');
          this._unwrap(extractHandler, 'domExtract');
        }
        const actHandler = (moduleExports.Stagehand.prototype.page).actHandler;
        if (actHandler) {
          this._unwrap(actHandler, 'act');
        }
      }
    }

    return moduleExports;
  }

  private patchStagehandConstructor() {
    const instrumentation = this;

    return (Original: any) => {
      // Create a constructor function that maintains the same signature
      const Stagehand = function (this: InstanceType<typeof Original>, ...args: any[]) {
        // Only apply if this is a new instance
        if (!(this instanceof Stagehand)) {
          return new (Stagehand)(...args);
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

    return (original: any) => async function method(this: any) {
      const sessionId = newUUID();

      // Make sure the parent span is set before calling the original init method
      // so that playwright instrumentation does not set its default parent span
      const parentSpan = Laminar.startSpan({
        name: 'Stagehand',
      });
      instrumentation.playwrightInstrumentation.setParentSpanForSession(sessionId, parentSpan);

      const result = await original.bind(this).apply(this);
      for (const page of this.context.pages()) {
        await instrumentation.playwrightInstrumentation.patchPage(page, sessionId);
      }
      await instrumentation.playwrightInstrumentation.patchPage(this.page, sessionId);

      instrumentation._wrap(
        this,
        'agent',
        instrumentation.patchStagehandAgentInitializer(sessionId),
      );

      // when new playwright page opens, we need to add playwright instrumentation
      // to it and instrument the stagehand page stored on the stagehand instance
      this.context.on('page', async (page: any) => {
        await instrumentation.playwrightInstrumentation.patchPage(page, sessionId);
        instrumentation.patchStagehandPage(this.stagehandPage, sessionId);
      });

      instrumentation.patchStagehandPage(this.stagehandPage, sessionId);
      if (this.llmClient) {
        instrumentation.globalLLMClientOptions.set(this.llmClient, {
          provider: this.llmClient.type,
          model: this.llmClient.modelName,
        });
        instrumentation._wrap(
          this.llmClient,
          'createChatCompletion',
          instrumentation.patchStagehandLLMClientCreateChatCompletion(),
        );
      }

      instrumentation.stagehandInstanceToSessionId.set(this, sessionId);
      return result;
    };
  }

  private patchStagehandClose() {
    const instrumentation = this;
    return (original: Function) => async function method(this: any, ...args: any[]) {
      // Clean up the session from the registry
      const sessionId = instrumentation.stagehandInstanceToSessionId.get(this);
      if (sessionId) {
        instrumentation.playwrightInstrumentation.removeAndEndParentSpanForSession(sessionId);
        instrumentation.stagehandInstanceToSessionId.delete(this);
      }

      await original.bind(this).apply(this, args);
    };
  }

  private patchStagehandPage(page: StagehandPage, sessionId: StringUUID) {
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
      if (extractHandler.textExtract) {
        this._wrap(
          extractHandler,
          'textExtract',
          this.patchStagehandExtractHandlerTextExtract(),
        );
      }

      if (extractHandler.domExtract) {
        this._wrap(
          extractHandler,
          'domExtract',
          this.patchStagehandExtractHandlerDomExtract(),
        );
      }
    }

    this._wrap(
      page,
      'act',
      this.patchStagehandGlobalMethod('act', sessionId),
    );

    this._wrap(
      page,
      'extract',
      this.patchStagehandGlobalMethod('extract', sessionId),
    );

    this._wrap(
      page,
      'observe',
      this.patchStagehandGlobalMethod('observe', sessionId),
    );
  }

  private patchStagehandGlobalMethod(methodName: string, sessionId: StringUUID) {
    const instrumentation = this;
    return (original: (...args: any[]) => Promise<any>) =>
      async function method(this: any, ...args: any[]) {
        const input = nameArgsOrCopy(args);
        if (methodName === "extract"
          && Array.isArray(input)
          && input.length > 0 && (input[0])?.schema
        ) {
          // We need to clone the input object to avoid mutating the original object
          // because the original object is passed to the LLM client
          const { schema, ...rest } = input[0];
          let prettySchema = schema?.shape;
          try {
            prettySchema = prettyPrintZodSchema(schema);
          } catch (error) {
            diag.warn('Error pretty printing zod schema', { error });
          }
          input[0] = { ...rest, schema: prettySchema };
        }
        return await Laminar.withSpan(
          instrumentation.playwrightInstrumentation.getParentSpanForSession(sessionId)!,
          async () => await laminarObserve(
            {
              name: `stagehand.${methodName}`,
              input,
            },
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

  // Stagehand uses zod 3.x, so we need to use the v3 version of zod
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

  private patchStagehandLLMClientCreateChatCompletion() {
    return createLLMClientCreateChatCompletionWrapper(this.globalLLMClientOptions);
  }

  private patchStagehandAgentInitializer(sessionId: StringUUID) {
    const instrumentation = this;
    return (original: (...args: any[]) => any) =>
      function agent(this: any, ...args: any[]) {
        if (args.length > 0 && typeof args[0] === 'object') {
          instrumentation.globalAgentOptions.set(this, args[0]);
        }
        const agent = original.bind(this).apply(this, args);
        instrumentation.patchStagehandAgent(agent, sessionId);
        return agent;
      };
  }

  private patchStagehandAgent(agent: AgentClient, sessionId: StringUUID) {
    this._wrap(
      agent,
      'execute',
      this.patchStagehandAgentExecute(sessionId),
    );
  }

  private patchStagehandAgentExecute(sessionId: StringUUID) {
    const instrumentation = this;
    return (original: (this: any, ...args: any[]) => Promise<any>) =>
      async function execute(this: any, ...args: any[]) {
        const input = nameArgsOrCopy(args);

        return await Laminar.withSpan(
          instrumentation.playwrightInstrumentation.getParentSpanForSession(sessionId)!,
          async () => await laminarObserve(
            {
              name: 'stagehand.agent.execute',
              input,
            },
            async () => await laminarObserve(
              {
                name: 'execute',
                // input and output are set as gen_ai.prompt and gen_ai.completion
                ignoreInput: true,
                ignoreOutput: true,
                spanType: "LLM",
              },
              async () => {
                const span = trace.getSpan(LaminarContextManager.getContext())
                  ?? trace.getActiveSpan();

                const provider = instrumentation.globalAgentOptions.get(this)?.provider
                  ?? instrumentation.globalLLMClientOptions.get(this)?.provider;
                const model = instrumentation.globalAgentOptions.get(this)?.model
                  ?? instrumentation.globalLLMClientOptions.get(this)?.model;
                span?.setAttributes({
                  ...(provider ? { "gen_ai.system": provider } : {}),
                  ...(model ? { "gen_ai.request.model": model } : {}),
                });

                let promptIndex = 0;
                if (instrumentation.globalAgentOptions.get(this)?.instructions) {
                  span?.setAttributes({
                    "gen_ai.prompt.0.content":
                      instrumentation.globalAgentOptions.get(this)?.instructions,
                    "gen_ai.prompt.0.role": "system",
                  });
                  promptIndex++;
                }

                const instruction = typeof input === 'string' ? input : (input as any).instruction;
                if (instruction) {
                  span?.setAttributes({
                    [`gen_ai.prompt.${promptIndex}.content`]: instruction,
                    [`gen_ai.prompt.${promptIndex}.role`]: "user",
                  });
                }

                const result = await original
                  .bind(this)
                  .apply(this, args);

                if (result.completed && result.success && result.message) {
                  const content = [{ type: "text", text: result.message }];
                  if (result.actions && result.actions.length > 0) {
                    content.push({
                      type: "text",
                      text: JSON.stringify({ actions: result.actions }),
                    });
                  }
                  span?.setAttributes({
                    "gen_ai.completion.0.content": JSON.stringify(content),
                    "gen_ai.completion.0.role": "assistant",
                  });
                } else if (result.completed && !result.success) {
                  span?.recordException(new Error(result.message));
                }
                if (result.usage) {
                  span?.setAttributes({
                    "gen_ai.usage.input_tokens": result.usage.input_tokens,
                    "gen_ai.usage.output_tokens": result.usage.output_tokens,
                    "llm.usage.total_tokens":
                      result.usage.input_tokens + result.usage.output_tokens,
                  });
                }
                return result;
              },
            ),
          ),
        );
      };
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
