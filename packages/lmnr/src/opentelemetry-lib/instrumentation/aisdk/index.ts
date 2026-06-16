import { type LanguageModelV3 } from "@ai-sdk/provider";
import { type LanguageModelV2 } from "@ai-sdk/provider-v2";
import { type LanguageModelV4 } from "@ai-sdk/provider-v4-canary";
import type * as AI from "ai";

import { initializeLogger } from "../../../utils";
import { getTracer } from "../../tracing";
import { LaminarLanguageModelV2 } from "./v2";
import { LaminarLanguageModelV3 } from "./v3";
import { LaminarLanguageModelV4 } from "./v4";

const AI_FUNCTIONS = [
  "generateText",
  "generateObject",
  "streamText",
  "streamObject",
  "embed",
  "embedMany",
  "rerank",
];

/**
 * Detect AI SDK v7 by the presence of `registerTelemetry` (added only in v7).
 * On v7 the wrapper injects `integrations: [laminarTelemetry()]`; on v6 it
 * falls back to the older `experimental_telemetry: { tracer }` path.
 */
const isAISDKv7 = (ai: typeof AI): boolean =>
  typeof (ai as any).registerTelemetry === "function";

const logger = initializeLogger();
let wrapAISDKv7WarnedOnce = false;

export const wrapAISDK = (ai: typeof AI): typeof AI => {
  const wrapped: Record<string, any> = {};
  const v7 = isAISDKv7(ai);

  if (v7) {
    if (!wrapAISDKv7WarnedOnce) {
      wrapAISDKv7WarnedOnce = true;
      logger.warn(
        "wrapAISDK() is not supported for AI SDK v7. " +
          "Use LaminarAiSdkTelemetry instead:\n" +
          "  import { LaminarAiSdkTelemetry } from '@lmnr-ai/lmnr';\n" +
          "  import { registerTelemetry } from 'ai';\n" +
          "  registerTelemetry(new LaminarAiSdkTelemetry());",
      );
    }
    return ai;
  }

  Object.entries(ai).forEach(([key, value]) => {
    if (typeof value === "function" && AI_FUNCTIONS.includes(key)) {
      const originalFn = value as (...args: any[]) => any;
      wrapped[key] = (...args: any[]) => {
        if (args[0] && typeof args[0] === "object") {
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

export function wrapLanguageModel(
  languageModel: LanguageModelV4,
): LanguageModelV4;
export function wrapLanguageModel(
  languageModel: LanguageModelV3,
): LanguageModelV3;
export function wrapLanguageModel(
  languageModel: LanguageModelV2,
): LanguageModelV2;
export function wrapLanguageModel(
  languageModel: LanguageModelV2 | LanguageModelV3 | LanguageModelV4,
): LanguageModelV2 | LanguageModelV3 | LanguageModelV4 {
  if (languageModel.specificationVersion === "v4") {
    return new LaminarLanguageModelV4(languageModel);
  }
  if (languageModel.specificationVersion === "v3") {
    return new LaminarLanguageModelV3(languageModel);
  }
  return new LaminarLanguageModelV2(languageModel);
}
