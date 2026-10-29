import { context } from "@opentelemetry/api";
import { hrTime, isTracingSuppressed } from "@opentelemetry/core";

import { LaminarContextManager } from "../../tracing/context";
import { LaminarSpan } from "../../tracing/span";
import { DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY } from "../openai-agents/helpers";
import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../shared/base";
import {
  finishSpan,
  instrumentStream,
  isAsyncIterable,
  recordSpanError,
  safely,
  settle,
  traceCall,
} from "../shared/utils";
import {
  createStreamState,
  finishStream,
  processCancel,
  processRequestError,
  processResponse,
  processStreamEvent,
  SpanOptions,
} from "./responses";
import {
  accumulateChatChunk,
  accumulateCompletionChunk,
  setChatPromptAttributes,
  setChoicesAttributes,
  setCompletionPromptAttributes,
  setDecisionRequestAttributes,
  setDecisionResponseAttributes,
  setEmbeddingsPromptAttributes,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

/**
 * Calls made by the OpenAI Agents SDK are already traced by its trace
 * processor, which sets this key around the model call.
 */
const isDisabledByAgents = (): boolean =>
  Boolean(
    LaminarContextManager.getContext().getValue(
      DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY,
    ) ??
      context
        .active()
        .getValue(DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY),
  );

const stripUndefined = (value: any): any => {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  );
};

type Handler = {
  spanName: string;
  // Skip calls the OpenAI Agents SDK already traces.
  skipForAgents?: boolean;
  setRequest: (
    span: LaminarSpan,
    params: any,
    instance: any,
    traceContent: boolean,
  ) => void;
  setResponse: (
    span: LaminarSpan,
    response: any,
    traceContent: boolean,
  ) => void;
  // Folds stream chunks into a full response; absent for non-streaming APIs.
  accumulate?: (complete: Record<string, any>, chunk: any) => void;
  // openai v3 resolves to an axios response with the body in `data`.
  unwrapBody?: (result: any) => any;
};

const setChatRequest: Handler["setRequest"] = (
  span,
  params,
  instance,
  traceContent,
) => {
  setRequestAttributes(span, params, instance);
  if (traceContent) setChatPromptAttributes(span, params);
};

const setCompletionRequest: Handler["setRequest"] = (
  span,
  params,
  instance,
  traceContent,
) => {
  setRequestAttributes(span, params, instance);
  if (traceContent) setCompletionPromptAttributes(span, params);
};

const setChoicesResponse: Handler["setResponse"] = (
  span,
  response,
  traceContent,
) => {
  setResponseAttributes(span, response);
  if (traceContent && !response?.error) setChoicesAttributes(span, response);
};

const CHAT: Handler = {
  spanName: "openai.chat",
  skipForAgents: true,
  setRequest: setChatRequest,
  setResponse: setChoicesResponse,
  accumulate: accumulateChatChunk,
};

const COMPLETION: Handler = {
  spanName: "openai.completion",
  setRequest: setCompletionRequest,
  setResponse: setChoicesResponse,
  accumulate: accumulateCompletionChunk,
};

const EMBEDDINGS: Handler = {
  spanName: "openai.embeddings",
  setRequest: (span, params, instance, traceContent) => {
    setRequestAttributes(span, params, instance);
    if (traceContent) setEmbeddingsPromptAttributes(span, params);
  },
  setResponse: (span, response) => setResponseAttributes(span, response),
};

const DECISION: Handler = {
  spanName: "openai.decision",
  setRequest: setDecisionRequestAttributes,
  setResponse: setDecisionResponseAttributes,
};

const unwrapAxiosBody = (result: any) => result?.data;

// v3 streams (`responseType: "stream"`) resolve to a raw Node stream of SSE
// bytes, so only the request is recorded for them.
const V3_CHAT: Handler = {
  ...CHAT,
  accumulate: undefined,
  unwrapBody: unwrapAxiosBody,
};

const V3_COMPLETION: Handler = {
  ...COMPLETION,
  accumulate: undefined,
  unwrapBody: unwrapAxiosBody,
};

const wrapMethod = (patched: PatchedMethod, handler: Handler) =>
  function (this: any, params: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (
      isTracingSuppressed(context.active()) ||
      (handler.skipForAgents && isDisabledByAgents())
    ) {
      return original.call(this, params, ...rest);
    }

    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: handler.spanName,
      spanType: "LLM",
    });
    safely(() => handler.setRequest(span, params, this, traceContent));

    return traceCall(
      span,
      () => original.call(this, params, ...rest),
      (data) => {
        const body = handler.unwrapBody ? handler.unwrapBody(data) : data;
        if (params?.stream) {
          const { accumulate } = handler;
          if (accumulate && isAsyncIterable(body)) {
            const complete: Record<string, any> = { choices: [] };
            instrumentStream(body, {
              onEvent: (chunk) => accumulate(complete, chunk),
              onDone: (error) => {
                safely(() => handler.setResponse(span, complete, traceContent));
                finishSpan(span, error);
              },
            });
            return data;
          }
        } else {
          safely(() => handler.setResponse(span, body, traceContent));
        }
        finishSpan(span);
        return data;
      },
    );
  };

type ResponsesKind = "create" | "retrieve" | "cancel";

const responsesParams = (kind: ResponsesKind, args: any[]): any => {
  switch (kind) {
    case "create":
      return stripUndefined(args[0]) ?? {};
    case "retrieve":
      return { response_id: args[0], ...stripUndefined(args[1] ?? {}) };
    case "cancel":
      return { response_id: args[0] };
  }
};

/**
 * `responses.create` / `retrieve` / `cancel`. Unlike the other APIs, the
 * span is built after the fact from the final response (see
 * `responses.ts`), so a background response spans from its `create` to the
 * `retrieve` / `cancel` that sees it finish.
 */
const wrapResponsesMethod = (patched: PatchedMethod, kind: ResponsesKind) =>
  function (this: any, ...args: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active()) || isDisabledByAgents()) {
      return original.apply(this, args);
    }

    const startTime = hrTime();
    const params = responsesParams(kind, args);
    const options: SpanOptions = {
      instance: this,
      instrumentation,
      parentContext: LaminarContextManager.getContext(),
      isRetrieve: kind === "retrieve",
    };

    let ended = false;
    const fail = (error: unknown) => {
      // A failed `cancel` leaves the response as it was, so it emits nothing.
      if (ended || kind === "cancel") return;
      ended = true;
      safely(() => {
        const span = processRequestError(startTime, params, options);
        finishSpan(span, error);
      });
    };
    const succeed = (data: any) => {
      if (ended) return data;
      ended = true;
      if (kind === "cancel") {
        safely(() => processCancel(data, options));
      } else if (isAsyncIterable(data)) {
        const state = createStreamState();
        instrumentStream(data, {
          onEvent: (event) => processStreamEvent(state, event),
          onDone: (error) => {
            const span = finishStream(startTime, state, params, options);
            if (!span) return;
            if (error !== undefined) recordSpanError(span, error);
            span.end();
          },
        });
      } else {
        safely(() => processResponse(startTime, data, params, options));
      }
      return data;
    };

    let result: any;
    try {
      result = original.apply(this, args);
    } catch (error) {
      fail(error);
      throw error;
    }
    return settle(result, succeed, fail);
  };

/**
 * Resolve the `OpenAI` client class from the module namespace, its default
 * export, or the class itself.
 */
const resolveClientClass = (mod: any): any => {
  for (const candidate of [mod?.OpenAI, mod?.default, mod]) {
    if (typeof candidate?.Chat?.Completions === "function") {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Resolve the openai v3 `OpenAIApi` class from the module namespace, its
 * default export, or the class itself.
 */
const resolveV3ApiClass = (mod: any): any => {
  for (const candidate of [mod?.OpenAIApi, mod?.default?.OpenAIApi, mod]) {
    if (typeof candidate?.prototype?.createChatCompletion === "function") {
      return candidate;
    }
  }
  return undefined;
};

type PatchTarget = {
  proto: any;
  method: string;
  wrap: (patched: PatchedMethod) => (...args: any[]) => any;
};

const handlerTarget = (
  proto: any,
  method: string,
  handler: Handler,
): PatchTarget => ({
  proto,
  method,
  wrap: (patched) => wrapMethod(patched, handler),
});

const responsesTarget = (proto: any, kind: ResponsesKind): PatchTarget => ({
  proto,
  method: kind,
  wrap: (patched) => wrapResponsesMethod(patched, kind),
});

/**
 * Everything to patch in the given module; prototypes are undefined where
 * the installed SDK version lacks the resource.
 */
const patchTargets = (moduleExports: any): PatchTarget[] => {
  const client = resolveClientClass(moduleExports);
  if (client) {
    const responses = client.Responses?.prototype;
    return [
      handlerTarget(client.Chat?.Completions?.prototype, "create", CHAT),
      handlerTarget(client.Completions?.prototype, "create", COMPLETION),
      handlerTarget(client.Embeddings?.prototype, "create", EMBEDDINGS),
      handlerTarget(client.Decisions?.prototype, "create", DECISION),
      responsesTarget(responses, "create"),
      responsesTarget(responses, "retrieve"),
      responsesTarget(responses, "cancel"),
    ];
  }
  const v3Api = resolveV3ApiClass(moduleExports)?.prototype;
  if (v3Api) {
    return [
      handlerTarget(v3Api, "createChatCompletion", V3_CHAT),
      handlerTarget(v3Api, "createCompletion", V3_COMPLETION),
    ];
  }
  return [];
};

/**
 * Instruments the `openai` package:
 * - openai >= 4: `chat.completions.create`, `completions.create`,
 *   `embeddings.create`, `decisions.create` and `responses.create` /
 *   `retrieve` / `cancel`. `chat.completions.parse()` / `stream()` /
 *   `runTools()` and `responses.parse()` / `stream()` delegate to `create`,
 *   so they are traced through it without nesting a second span.
 * - openai v3: `OpenAIApi#createChatCompletion` / `createCompletion`.
 */
export class OpenAIInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("openai", config);
  }

  /**
   * Manual instrumentation accepts the `openai` module namespace or the
   * `OpenAI` class (the module's default export). For openai v3, the module
   * or its `OpenAIApi` class.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "openai",
        supportedVersions: [">=3.1.0"],
        patch: (moduleExports) => {
          for (const { proto, method, wrap } of patchTargets(moduleExports)) {
            this.wrapMethod(proto, method, wrap);
          }
        },
        unpatch: (moduleExports) => {
          for (const { proto, method } of patchTargets(moduleExports)) {
            this.unwrapMethod(proto, method);
          }
        },
        accepts: (input) => patchTargets(input).length > 0,
      },
    ];
  }
}
