import { context, diag, SpanStatusCode } from "@opentelemetry/api";
import { hrTime, isTracingSuppressed } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { LaminarSpan } from "../../tracing/span";
import { DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY } from "../openai-agents/helpers";
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

const logger = initializeLogger();

const PATCH_DATA_SYMBOL = Symbol("lmnr.openai.patchData");

type MethodPatchData = {
  traceContent: boolean;
  original: (...args: any[]) => any;
};

// Patch data lives on the exact prototype it wraps, never an inherited one.
// One prototype can carry several patched methods (`Responses`), so the
// data is keyed by method name.
const hasOwnPatchData = (proto: any): boolean =>
  Object.getOwnPropertyDescriptor(proto, PATCH_DATA_SYMBOL) !== undefined;

const markSpanError = (span: LaminarSpan, error: unknown): void => {
  span.recordException(error as Error);
  span.setAttribute(
    "error.type",
    (error as Error)?.constructor?.name ?? "Error",
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
};

/**
 * Attribute extraction must never break the user's call.
 */
const safely = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    logger.debug(`Failed to set openai span attributes: ${String(error)}`);
  }
};

const isAsyncIterable = (value: any): boolean =>
  value !== null &&
  typeof value === "object" &&
  typeof value[Symbol.asyncIterator] === "function";

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

/**
 * Wrap the events of an SDK `Stream` as the caller iterates them. The stream
 * object itself is kept, so `tee()`, `toReadableStream()`, `controller` and
 * the SDK's stream helpers (`ChatCompletionStream`, `ResponseStream`) keep
 * working. `onDone` runs exactly once: on completion, on an iteration error,
 * or when the caller stops early.
 */
const instrumentStream = (
  stream: any,
  onEvent: (event: any) => void,
  onDone: (error?: unknown) => void,
): void => {
  let done = false;
  const finish = (error?: unknown) => {
    if (done) return;
    done = true;
    onDone(error);
  };
  const wrap = (makeIterator: () => AsyncIterator<any>) =>
    async function* () {
      const iterable = { [Symbol.asyncIterator]: makeIterator };
      try {
        for await (const event of iterable) {
          safely(() => onEvent(event));
          yield event;
        }
      } catch (error) {
        finish(error);
        throw error;
      } finally {
        finish();
      }
    };

  // openai >= 4: `[Symbol.asyncIterator]()` and `tee()` both call the
  // instance's `iterator` field, so wrapping it covers both.
  if (typeof stream.iterator === "function") {
    stream.iterator = wrap(stream.iterator);
    return;
  }
  stream[Symbol.asyncIterator] = wrap(
    stream[Symbol.asyncIterator].bind(stream),
  );
};

/**
 * Hand the result of the original call to `succeed` / `fail`. An
 * `APIPromise` stays one, so the caller keeps `withResponse()` /
 * `asResponse()`.
 */
const settle = (
  result: any,
  succeed: (data: any) => any,
  fail: (error: unknown) => void,
): any => {
  if (typeof result?._thenUnwrap === "function") {
    // Request failures (HTTP errors, connection errors) reject the raw
    // response promise.
    const responsePromise =
      typeof result._responseProps === "function"
        ? result._responseProps()
        : result.responsePromise;
    if (typeof responsePromise?.then === "function") {
      responsePromise.then(undefined, fail);
    }
    return result._thenUnwrap(succeed);
  }
  if (typeof result?.then === "function") {
    return result.then(succeed, (error: unknown) => {
      fail(error);
      throw error;
    });
  }
  return succeed(result);
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

const wrapMethod = (patchData: MethodPatchData, handler: Handler) =>
  function (this: any, params: any, ...rest: any[]) {
    const { original } = patchData;
    if (
      isTracingSuppressed(context.active()) ||
      (handler.skipForAgents && isDisabledByAgents())
    ) {
      return original.call(this, params, ...rest);
    }

    const traceContent = patchData.traceContent;
    const span = Laminar.startSpan({
      name: handler.spanName,
      spanType: "LLM",
    }) as LaminarSpan;
    safely(() => handler.setRequest(span, params, this, traceContent));

    let result: any;
    try {
      // Boxed so `withSpan` doesn't chain onto the APIPromise, which would
      // turn it into a plain Promise without `withResponse()`/`asResponse()`.
      result = Laminar.withSpan(span, () => ({
        value: original.call(this, params, ...rest),
      })).value;
    } catch (error) {
      markSpanError(span, error);
      span.end();
      throw error;
    }

    let ended = false;
    const fail = (error: unknown) => {
      if (ended) return;
      ended = true;
      markSpanError(span, error);
      span.end();
    };
    const succeed = (data: any) => {
      if (ended) return data;
      ended = true;
      const body = handler.unwrapBody ? handler.unwrapBody(data) : data;
      if (params?.stream) {
        const { accumulate } = handler;
        if (accumulate && isAsyncIterable(body)) {
          const complete: Record<string, any> = { choices: [] };
          instrumentStream(
            body,
            (chunk) => accumulate(complete, chunk),
            (error) => {
              safely(() => handler.setResponse(span, complete, traceContent));
              if (error !== undefined) {
                markSpanError(span, error);
              } else {
                span.setStatus({ code: SpanStatusCode.OK });
              }
              span.end();
            },
          );
          return data;
        }
      } else {
        safely(() => handler.setResponse(span, body, traceContent));
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return data;
    };

    return settle(result, succeed, fail);
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
const wrapResponsesMethod = (patchData: MethodPatchData, kind: ResponsesKind) =>
  function (this: any, ...args: any[]) {
    const { original } = patchData;
    if (isTracingSuppressed(context.active()) || isDisabledByAgents()) {
      return original.apply(this, args);
    }

    const startTime = hrTime();
    const params = responsesParams(kind, args);
    const options: SpanOptions = {
      instance: this,
      traceContent: patchData.traceContent,
      parentContext: LaminarContextManager.getContext(),
    };

    let ended = false;
    const fail = (error: unknown) => {
      // A failed `cancel` leaves the response as it was, so it emits nothing.
      if (ended || kind === "cancel") return;
      ended = true;
      safely(() => {
        const span = processRequestError(startTime, params, options);
        markSpanError(span, error);
        span.end();
      });
    };
    const succeed = (data: any) => {
      if (ended) return data;
      ended = true;
      if (kind === "cancel") {
        safely(() => processCancel(data, options));
      } else if (isAsyncIterable(data)) {
        const state = createStreamState();
        instrumentStream(
          data,
          (event) => processStreamEvent(state, event),
          (error) =>
            safely(() => {
              const span = finishStream(startTime, state, params, options);
              if (error !== undefined) markSpanError(span, error);
              span.end();
            }),
        );
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
  wrap: (patchData: MethodPatchData) => (...args: any[]) => any;
};

const handlerTarget = (
  proto: any,
  method: string,
  handler: Handler,
): PatchTarget => ({
  proto,
  method,
  wrap: (patchData) => wrapMethod(patchData, handler),
});

const responsesTarget = (proto: any, kind: ResponsesKind): PatchTarget => ({
  proto,
  method: kind,
  wrap: (patchData) => wrapResponsesMethod(patchData, kind),
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
export class OpenAIInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/openai-instrumentation", SDK_VERSION, {
      enabled: true,
    });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "openai",
      [">=3.1.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  /**
   * Accepts the `openai` module namespace or the `OpenAI` class (the
   * module's default export). For openai v3, the module or its `OpenAIApi`
   * class.
   */
  public manuallyInstrument(module: any): void {
    if (!patchTargets(module).length) {
      diag.warn(
        "Could not find the OpenAI client in openai manual " +
          "instrumentation input. Pass the openai module.",
      );
      return;
    }
    diag.debug("Manually instrumenting openai");
    this.patch(module);
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching openai");
    for (const target of patchTargets(moduleExports)) {
      this.patchMethod(target);
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching openai");
    for (const { proto, method } of patchTargets(moduleExports)) {
      if (!proto || !hasOwnPatchData(proto)) continue;
      const patchData = proto[PATCH_DATA_SYMBOL];
      if (!patchData[method]) continue;
      proto[method] = patchData[method].original;
      delete patchData[method];
      if (!Object.keys(patchData).length) {
        delete proto[PATCH_DATA_SYMBOL];
      }
    }
  }

  /**
   * Replace `proto[method]` with a traced wrapper. Re-patching an already
   * patched method only refreshes `traceContent`, so repeated
   * initialization never double-wraps.
   */
  private patchMethod({ proto, method, wrap }: PatchTarget): void {
    if (!proto || typeof proto[method] !== "function") return;

    if (!hasOwnPatchData(proto)) {
      Object.defineProperty(proto, PATCH_DATA_SYMBOL, {
        value: {},
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    const existing: MethodPatchData | undefined =
      proto[PATCH_DATA_SYMBOL][method];
    if (existing) {
      existing.traceContent = this.traceContent;
      return;
    }

    const patchData: MethodPatchData = {
      traceContent: this.traceContent,
      original: proto[method],
    };
    proto[PATCH_DATA_SYMBOL][method] = patchData;
    proto[method] = wrap(patchData);
  }
}
