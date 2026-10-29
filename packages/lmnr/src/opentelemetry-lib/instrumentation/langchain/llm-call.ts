import { createContextKey } from "@opentelemetry/api";

/**
 * Context key carrying the LangChain LLM call currently in progress. Set by the
 * `BaseChatModel` / `BaseLLM` wrappers for the duration of the model call.
 *
 * Kept free of other imports: `Laminar._startSpan` reads it to tell a handed
 * off call that the provider SDK instrumentation did record its span.
 */
export const LLM_CALL_KEY = createContextKey("lmnr.langchain.llm_call");

export type LlmCall = {
  /**
   * `handoff`: a Laminar provider instrumentation (OpenAI, Anthropic) is
   * expected to record the call, so LangChain opens no LLM span of its own.
   * `own`: the LangChain callback handler records the LLM span and provider
   * instrumentations underneath are suppressed.
   */
  mode: "handoff" | "own";
  /** Set once an LLM span was started under a handed-off call. */
  recorded: boolean;
};
