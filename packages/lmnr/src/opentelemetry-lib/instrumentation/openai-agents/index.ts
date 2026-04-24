import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger } from "../../../utils";
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

/* eslint-disable
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-argument
*/

type ModelRequestLike = {
  systemInstructions?: string;
} | undefined;

const wrapGetResponse = (original: Function): Function =>
  function (this: any, request: ModelRequestLike, ...rest: any[]) {
    const systemInstructions = request?.systemInstructions;
    return runWithSystemInstructions(systemInstructions, () =>
      original.call(this, request, ...rest),
    );
  };

const wrapGetStreamedResponse = (original: Function): Function =>
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

export class OpenAIAgentsInstrumentation extends InstrumentationBase {
  private _processor: LaminarAgentsTraceProcessor | undefined;

  constructor() {
    super("@lmnr/openai-agents-instrumentation", SDK_VERSION, {
      enabled: true,
    });
  }

  protected init(): InstrumentationModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        "@openai/agents",
        [">=0.0.1"],
        this.patchAgents.bind(this),
        this.unpatchAgents.bind(this),
      ),
      new InstrumentationNodeModuleDefinition(
        "@openai/agents-openai",
        [">=0.0.1"],
        this.patchAgentsOpenAI.bind(this),
        this.unpatchAgentsOpenAI.bind(this),
      ),
    ];
  }

  public manuallyInstrument(agentsModule: any) {
    if (!agentsModule) {
      logger.debug("@openai/agents module not provided, skipping");
      return;
    }
    this.registerProcessor(agentsModule);
    this.patchModel(agentsModule);
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

  private patchModel(module: AgentsOpenAIModule) {
    for (const cls of [
      module.OpenAIResponsesModel,
      module.OpenAIChatCompletionsModel,
    ]) {
      if (!cls || !cls.prototype) {
        continue;
      }
      for (const method of MODEL_METHODS) {
        if (typeof cls.prototype[method] !== "function") {
          continue;
        }
        const wrapper = method === "getResponse"
          ? wrapGetResponse
          : wrapGetStreamedResponse;
        try {
          this._wrap(cls.prototype, method, wrapper as any);
        } catch (e) {
          logger.debug(`Failed to wrap ${method}: ${String(e)}`);
        }
      }
    }
  }

  private unpatchModel(module: AgentsOpenAIModule) {
    for (const cls of [
      module.OpenAIResponsesModel,
      module.OpenAIChatCompletionsModel,
    ]) {
      if (!cls || !cls.prototype) {
        continue;
      }
      for (const method of MODEL_METHODS) {
        try {
          this._unwrap(cls.prototype, method);
        } catch {
          // ignore
        }
      }
    }
  }

  private patchAgents(moduleExports: any): any {
    diag.debug("Patching @openai/agents");
    this.registerProcessor(moduleExports as AgentsTracingModule);
    // @openai/agents re-exports @openai/agents-openai, so model classes are here
    this.patchModel(moduleExports as AgentsOpenAIModule);
    return moduleExports;
  }

  private unpatchAgents(moduleExports: any): void {
    diag.debug("Unpatching @openai/agents");
    this.unpatchModel(moduleExports as AgentsOpenAIModule);
  }

  private patchAgentsOpenAI(moduleExports: any): any {
    diag.debug("Patching @openai/agents-openai");
    this.patchModel(moduleExports as AgentsOpenAIModule);
    return moduleExports;
  }

  private unpatchAgentsOpenAI(moduleExports: any): void {
    diag.debug("Unpatching @openai/agents-openai");
    this.unpatchModel(moduleExports as AgentsOpenAIModule);
  }
}
/* eslint-enable
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-argument
*/
