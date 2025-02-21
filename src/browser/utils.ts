type LLMClient = any; // import { LLMClient } from "@browserbasehq/stagehand";

export function cleanStagehandLLMClientForLaminarObserve(
    llmClient: any,
  ): Omit<LLMClient, "client"> {
    return Object.fromEntries(
      Object.entries(llmClient)
        .filter(([key]) => key !== "client")
        .map(([key, value]) =>
          key === "clientOptions"
            ? [
                key,
                Object.fromEntries(
                  Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "apiKey"),
                ),
              ]
            : [key, value],
        ),
    ) as Omit<LLMClient, "client">;
  }