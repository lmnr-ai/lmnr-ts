import { LanguageModelV3 } from "@ai-sdk/provider";
import { LanguageModelV2 } from "@ai-sdk/provider-v2";
import type * as AI from "ai";

import { getTracer } from "../../tracing";
import { LaminarLanguageModelV2 } from "./v2";
import { LaminarLanguageModelV3 } from "./v3";

const AI_FUNCTIONS = [
  'generateText',
  'generateObject',
  'streamText',
  'streamObject',
  'embed',
  'embedMany',
];

export const wrapAISDK = (ai: typeof AI): typeof AI => {
  const wrapped: Record<string, any> = {};
  Object.entries(ai).forEach(([key, value]) => {
    if (typeof value === 'function' && AI_FUNCTIONS.includes(key)) {
      const originalFn = value as (...args: any[]) => any;
      wrapped[key] = (...args: any[]) => {
        if (args[0] && typeof args[0] === 'object') {
          const defaultTelemetry = {
            isEnabled: true,
            tracer: getTracer(),
          };
          args[0] = {
            ...args[0],
            experimental_telemetry: {
              ...defaultTelemetry,
              ...args[0].experimental_telemetry,
            },
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return originalFn(...args);
      };
    } else {
      wrapped[key] = value;
    }
  });
  return wrapped as typeof AI;
};

export function laminarLanguageModel(languageModel: LanguageModelV3): LanguageModelV3;
export function laminarLanguageModel(languageModel: LanguageModelV2): LanguageModelV2;
export function laminarLanguageModel(
  languageModel: LanguageModelV2 | LanguageModelV3,
): LanguageModelV2 | LanguageModelV3 {
  if (languageModel.specificationVersion === 'v3') {
    return new LaminarLanguageModelV3(languageModel);
  }
  return new LaminarLanguageModelV2(languageModel);
}
