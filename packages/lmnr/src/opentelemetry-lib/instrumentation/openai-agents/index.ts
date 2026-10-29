// biome-ignore-all lint/complexity/noBannedTypes: instrumentation wraps arbitrary Functions
import { initializeLogger } from "../../../utils";
import { InstrumentedModule, LaminarInstrumentation } from "../shared/base";
import {
  runWithSystemInstructions,
  wrapStreamWithSystemInstructions,
} from "./helpers";
import { LaminarAgentsTraceProcessor } from "./processor";

export {
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY,
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY_RAW,
} from "./helpers";
export { LaminarAgentsTraceProcessor } from "./processor";

const logger = initializeLogger();

type ModelRequestLike =
  | {
      systemInstructions?: string;
    }
  | undefined;

const wrapGetResponse = (
  original: (...args: any[]) => any,
): ((...args: any[]) => any) =>
  function (this: any, request: ModelRequestLike, ...rest: any[]) {
    const systemInstructions = request?.systemInstructions;
    return runWithSystemInstructions(systemInstructions, () =>
      original.call(this, request, ...rest),
    );
  };

const wrapGetStreamedResponse = (
  original: (...args: any[]) => any,
): ((...args: any[]) => any) =>
  function (this: any, request: ModelRequestLike, ...rest: any[]) {
    const systemInstructions = request?.systemInstructions;
    const source = original.call(this, request, ...rest) as AsyncIterable<any>;
    return wrapStreamWithSystemInstructions(systemInstructions, source);
  };

const MODEL_METHODS: readonly ["getResponse", "getStreamedResponse"] = [
  "getResponse",
  "getStreamedResponse",
];

type AgentsOpenAIModule = {
  OpenAIResponsesModel?: { prototype: any };
  OpenAIChatCompletionsModel?: { prototype: any };
};

type AgentsTracingModule = {
  addTraceProcessor?: (processor: any) => void;
};

export class OpenAIAgentsInstrumentation extends LaminarInstrumentation {
  private _processor: LaminarAgentsTraceProcessor | undefined;

  constructor() {
    super("openai-agents");
  }

  /**
   * Manual instrumentation accepts the `@openai/agents` module, or any object
   * with `addTraceProcessor` and / or the model classes.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@openai/agents",
        supportedVersions: [">=0.0.1"],
        patch: (moduleExports) => {
          this.registerProcessor(moduleExports as AgentsTracingModule);
          // @openai/agents re-exports @openai/agents-openai, so model classes
          // are here
          this.patchModel(moduleExports as AgentsOpenAIModule);
        },
        unpatch: (moduleExports) =>
          this.unpatchModel(moduleExports as AgentsOpenAIModule),
        accepts: (input) => Boolean(input),
      },
      {
        name: "@openai/agents-openai",
        supportedVersions: [">=0.0.1"],
        patch: (moduleExports) =>
          this.patchModel(moduleExports as AgentsOpenAIModule),
        unpatch: (moduleExports) =>
          this.unpatchModel(moduleExports as AgentsOpenAIModule),
      },
    ];
  }

  private registerProcessor(module: AgentsTracingModule) {
    if (this._processor !== undefined) {
      return;
    }
    const addTraceProcessor = module.addTraceProcessor;
    if (typeof addTraceProcessor !== "function") {
      logger.debug("addTraceProcessor not found in @openai/agents module");
      return;
    }
    try {
      const processor = new LaminarAgentsTraceProcessor();
      addTraceProcessor(processor);
      this._processor = processor;
    } catch (e) {
      logger.debug(`Failed to register Laminar Agents processor: ${String(e)}`);
    }
  }

  // @openai/agents re-exports the model classes from @openai/agents-openai, so
  // the same prototype is seen twice; `wrapMethod` only wraps it once.
  private patchModel(module: AgentsOpenAIModule) {
    for (const proto of modelPrototypes(module)) {
      this.wrapMethod(proto, "getResponse", ({ original }) =>
        wrapGetResponse(original),
      );
      this.wrapMethod(proto, "getStreamedResponse", ({ original }) =>
        wrapGetStreamedResponse(original),
      );
    }
  }

  private unpatchModel(module: AgentsOpenAIModule) {
    for (const proto of modelPrototypes(module)) {
      for (const method of MODEL_METHODS) {
        this.unwrapMethod(proto, method);
      }
    }
  }
}

const modelPrototypes = (module: AgentsOpenAIModule): any[] =>
  [module?.OpenAIResponsesModel, module?.OpenAIChatCompletionsModel]
    .map((cls) => cls?.prototype)
    .filter(Boolean);
