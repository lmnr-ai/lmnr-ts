import type * as AI from "ai";
import { getTracer } from "../tracing";

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
        return originalFn(...args);
      };
    } else {
      wrapped[key] = value;
    }
  });
  return wrapped as typeof AI;
}
