import { type LanguageModelV3 } from "@ai-sdk/provider";
import { type LanguageModelV2 } from "@ai-sdk/provider-v2";
import type * as AI from "ai";

import { getTracer } from "../../tracing";
import { LaminarLanguageModelV2 } from "./v2";
import { LaminarLanguageModelV3 } from "./v3";
import { aiSdkTelemetry } from "./v7-integration/index";

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

export const wrapAISDK = (ai: typeof AI): typeof AI => {
  const wrapped: Record<string, any> = {};
  const v7 = isAISDKv7(ai);
  // Create one integration per wrap() call so registrations are stable
  // across calls within the same process but distinct across test runs.
  const v7Integration = v7 ? aiSdkTelemetry() : undefined;

  Object.entries(ai).forEach(([key, value]) => {
    if (typeof value === "function" && AI_FUNCTIONS.includes(key)) {
      const originalFn = value as (...args: any[]) => any;
      wrapped[key] = (...args: any[]) => {
        if (args[0] && typeof args[0] === "object") {
          if (v7) {
            const userTelemetry =
              args[0].telemetry ?? args[0].experimental_telemetry ?? {};
            const mergedIntegrations: any[] = [v7Integration];
            const userIntegrations = userTelemetry.integrations;
            if (Array.isArray(userIntegrations)) {
              mergedIntegrations.push(...userIntegrations);
            } else if (userIntegrations) {
              mergedIntegrations.push(userIntegrations);
            }
            args[0] = {
              ...args[0],
              telemetry: {
                isEnabled: true,
                ...userTelemetry,
                integrations: mergedIntegrations,
              },
            };
          } else {
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
  languageModel: LanguageModelV3,
): LanguageModelV3;
export function wrapLanguageModel(
  languageModel: LanguageModelV2,
): LanguageModelV2;
export function wrapLanguageModel(
  languageModel: LanguageModelV2 | LanguageModelV3,
): LanguageModelV2 | LanguageModelV3 {
  if (languageModel.specificationVersion === "v3") {
    return new LaminarLanguageModelV3(languageModel);
  }
  return new LaminarLanguageModelV2(languageModel);
}
