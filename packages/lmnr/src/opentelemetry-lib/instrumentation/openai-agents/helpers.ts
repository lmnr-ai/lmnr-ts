import { createContextKey } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";

// Laminar context key used to tell the OpenAI Responses API instrumentation
// (once we add one to the TS SDK) that the current call is already being
// tracked by the OpenAI Agents trace processor, so it should skip creating
// a duplicate span for the same underlying HTTP request.
//
// We keep the raw key string alongside the symbol because
// @opentelemetry/api's createContextKey returns an opaque symbol and some
// downstream code (or future OpenAI Responses instrumentation) may want to
// reference the human-readable name.
export const DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY_RAW =
  "LMNR_DISABLE_OPENAI_RESPONSES_INSTRUMENTATION";
export const DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY = createContextKey(
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY_RAW,
);

// Task-local system instructions for the currently-executing model call.
// Set by the wrapped getResponse / getStreamedResponse methods in index.ts
// and read by the response/generation span_data handlers so the system
// prompt can be prepended to gen_ai.input.messages.
const systemInstructionsStorage = new AsyncLocalStorage<string | undefined>();

export const getCurrentSystemInstructions = (): string | undefined =>
  systemInstructionsStorage.getStore();

export const runWithSystemInstructions = <T>(
  value: string | undefined,
  fn: () => T,
): T => systemInstructionsStorage.run(value, fn);

/* eslint-disable
  @typescript-eslint/prefer-promise-reject-errors,
  @typescript-eslint/no-unused-vars
*/
// Wrap an async iterable so that the system instructions ALS value is set for
// each iteration step. We can't simply call `systemInstructionsStorage.run()`
// once around generator creation, because the ALS context is restored as soon
// as `.run()` returns — subsequent `next()` calls would see the old value.
export const wrapStreamWithSystemInstructions = <T>(
  value: string | undefined,
  source: AsyncIterable<T>,
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    let iterator: AsyncIterator<T> | undefined;
    const getIterator = (): AsyncIterator<T> => {
      if (iterator === undefined) {
        iterator = systemInstructionsStorage.run(value, () =>
          source[Symbol.asyncIterator](),
        );
      }
      return iterator;
    };
    return {
      next: (..._args: [] | [undefined]) =>
        systemInstructionsStorage.run(value, () => getIterator().next()),
      return: (returnValue?: any) => {
        const it = getIterator();
        return it.return
          ? systemInstructionsStorage.run(value, () => it.return!(returnValue))
          : Promise.resolve({ done: true, value: returnValue });
      },
      throw: (err?: any) => {
        const it = getIterator();
        return it.throw
          ? systemInstructionsStorage.run(value, () => it.throw!(err))
          : Promise.reject(err);
      },
    };
  },
});
/* eslint-enable
  @typescript-eslint/prefer-promise-reject-errors,
  @typescript-eslint/no-unused-vars
*/

export const spanKind = (spanData: any): string => {
  if (spanData == null) {
    return "";
  }
  return typeof spanData.type === "string" ? (spanData.type as string) : "";
};

export const spanName = (span: any, spanData: any): string => {
  const name = span?.name;
  if (typeof name === "string" && name) {
    return name;
  }
  const kind = spanKind(spanData);
  if (kind) {
    if (kind === "agent" || kind === "custom" || kind === "function" || kind === "tool") {
      return nameFromSpanData(spanData) || `agents.${kind}`;
    }
    return `agents.${kind}`;
  }
  return "agents.span";
};

export type LaminarAgentsSpanType = "LLM" | "TOOL" | "DEFAULT";

export const mapSpanType = (spanData: any): LaminarAgentsSpanType => {
  const kind = spanKind(spanData);
  if (
    kind === "generation" ||
    kind === "response" ||
    kind === "transcription" ||
    kind === "speech" ||
    kind === "speech_group"
  ) {
    return "LLM";
  }
  if (
    kind === "function" ||
    kind === "tool" ||
    kind === "mcp_list_tools" ||
    kind === "mcp_tools" ||
    kind === "handoff"
  ) {
    return "TOOL";
  }
  return "DEFAULT";
};

export const nameFromSpanData = (agent: any): string => {
  if (agent == null) {
    return "";
  }
  if (typeof agent === "string") {
    return agent;
  }
  if (typeof agent === "object") {
    if (typeof agent.name === "string") {
      return agent.name as string;
    }
  }
  return "";
};

export const getFirstNotNull = (d: Record<string, any>, ...keys: string[]): any => {
  for (const key of keys) {
    const v = d?.[key];
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
};

export const getAttrNotNull = (obj: any, ...attrs: string[]): any => {
  if (obj == null) {
    return undefined;
  }
  for (const attr of attrs) {
    const v = obj[attr];
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
};

export const modelAsDict = (obj: any): Record<string, any> | undefined => {
  if (obj == null) {
    return undefined;
  }
  if (typeof obj !== "object") {
    return undefined;
  }
  if (Array.isArray(obj)) {
    return undefined;
  }
  // Plain object
  return obj as Record<string, any>;
};

export const normalizeMessages = (
  data: any,
  role: string = "user",
): Record<string, any>[] => {
  if (data == null) {
    return [];
  }

  if (typeof data === "string") {
    return [{ role, content: data }];
  }

  if (Array.isArray(data)) {
    const messages: Record<string, any>[] = [];
    for (const item of data) {
      if (item != null && typeof item === "object" && !Array.isArray(item)) {
        messages.push(item as Record<string, any>);
      } else {
        messages.push({ role, content: String(item) });
      }
    }
    return messages;
  }

  if (typeof data === "object") {
    return [data as Record<string, any>];
  }

  return [{ role, content: String(data) }];
};
