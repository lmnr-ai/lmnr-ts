import { context, SpanStatusCode } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";
import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../shared/base";
import {
  ChatStreamAccumulator,
  createV1ChatStreamAccumulator,
  createV2ChatStreamAccumulator,
  RequestType,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

const logger = initializeLogger();

type MethodSpec = {
  method: string;
  requestType: RequestType;
  streaming: boolean;
};

const SPAN_NAMES: Record<RequestType, string> = {
  chat: "cohere.chat",
  completion: "cohere.completion",
  rerank: "cohere.rerank",
  embedding: "cohere.embed",
};

// `generateStream` is not instrumented (neither was it by OpenLLMetry).
const V1_METHODS: MethodSpec[] = [
  { method: "chat", requestType: "chat", streaming: false },
  { method: "chatStream", requestType: "chat", streaming: true },
  { method: "generate", requestType: "completion", streaming: false },
  { method: "rerank", requestType: "rerank", streaming: false },
  { method: "embed", requestType: "embedding", streaming: false },
];

const V2_METHODS: MethodSpec[] = [
  { method: "chat", requestType: "chat", streaming: false },
  { method: "chatStream", requestType: "chat", streaming: true },
  { method: "rerank", requestType: "rerank", streaming: false },
  { method: "embed", requestType: "embedding", streaming: false },
];

const markSpanError = (span: LaminarSpan, error: unknown): void => {
  span.recordException(error as Error);
  span.setAttribute(
    "error.type",
    (error as Error)?.constructor?.name ?? "Error",
  );
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: (error as Error)?.message,
  });
};

/**
 * Attribute extraction must never break the user's call.
 */
const safely = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    logger.debug(`Failed to set cohere span attributes: ${String(error)}`);
  }
};

const isAsyncIterable = (value: any): boolean =>
  value !== null &&
  typeof value === "object" &&
  typeof value[Symbol.asyncIterator] === "function";

/**
 * The prototype in `proto`'s chain that defines `method`, so subclasses
 * (`CohereClient` is a thin `CustomClient` subclass) share one wrapper.
 */
const definingPrototype = (proto: any, method: string): any => {
  for (
    let p = proto;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(p, method);
    if (descriptor) {
      return typeof descriptor.value === "function" ? p : undefined;
    }
  }
  return undefined;
};

/**
 * Resolve the `cohere-ai` module namespace from the namespace itself or its
 * default export (ESM default import of the CJS package).
 */
const resolveModule = (mod: any): any => {
  for (const candidate of [mod, mod?.default]) {
    if (typeof candidate?.CohereClient === "function") {
      return candidate;
    }
  }
  return undefined;
};

/**
 * `V2Client` is not exported from the package root, so read its prototype
 * off a throwaway client: `CohereClient#v2` (lazy getter) or
 * `CohereClientV2#clientV2`. Constructing a client does no I/O.
 */
const v2ClientPrototype = (mod: any): any => {
  const probes = [
    () => new mod.CohereClient({ token: "lmnr" }).v2,
    () => new mod.CohereClientV2({ token: "lmnr" }).clientV2,
  ];
  for (const probe of probes) {
    try {
      const client = probe();
      if (client && typeof client === "object") {
        return Object.getPrototypeOf(client);
      }
    } catch {
      // older SDKs without the v2 API
    }
  }
  return undefined;
};

/**
 * Instruments `cohere-ai`: v1 `chat`, `chatStream`, `generate`, `rerank` and
 * `embed` on `CohereClient`, and v2 `chat`, `chatStream`, `rerank` and
 * `embed` on `V2Client` (behind `CohereClientV2` and `CohereClient#v2`).
 *
 * `CohereClientV2` binds its methods as instance fields in its constructor,
 * so clients created before instrumentation are not traced.
 */
export class CohereInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("cohere", config);
  }

  /**
   * Manual instrumentation accepts the `cohere-ai` module namespace
   * (`import * as cohere from "cohere-ai"`) or its default export.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "cohere-ai",
        supportedVersions: [">=7.0.0"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) => this.unpatch(moduleExports),
        accepts: (input) => resolveModule(input) !== undefined,
      },
    ];
  }

  private patch(moduleExports: any): void {
    for (const { proto, specs, isV2 } of patchTargets(moduleExports)) {
      for (const spec of specs) {
        this.wrapMethod(
          definingPrototype(proto, spec.method),
          spec.method,
          (patched) => wrapMethod(patched, spec, isV2),
        );
      }
    }
  }

  private unpatch(moduleExports: any): void {
    for (const { proto, specs } of patchTargets(moduleExports)) {
      for (const { method } of specs) {
        this.unwrapMethod(definingPrototype(proto, method), method);
      }
    }
  }
}

const patchTargets = (
  moduleExports: any,
): { proto: any; specs: MethodSpec[]; isV2: boolean }[] => {
  const mod = resolveModule(moduleExports);
  if (!mod) return [];
  const v1 = mod.CohereClient.prototype;
  const v2 = v2ClientPrototype(mod);
  const targets = [{ proto: v1, specs: V1_METHODS, isV2: false }];
  // Guard against an SDK where the v2 client is the v1 class itself.
  if (v2 && definingPrototype(v2, "chat") !== definingPrototype(v1, "chat")) {
    targets.push({ proto: v2, specs: V2_METHODS, isV2: true });
  }
  return targets;
};

const wrapMethod = (
  patched: PatchedMethod,
  { requestType, streaming }: MethodSpec,
  isV2: boolean,
) =>
  function (this: any, request: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, ...rest);
    }

    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: SPAN_NAMES[requestType],
      spanType: "LLM",
    });
    safely(() =>
      setRequestAttributes(
        span,
        request,
        requestType,
        isV2,
        streaming,
        traceContent,
      ),
    );

    let result: any;
    try {
      // Boxed so `withSpan` doesn't chain onto the `HttpResponsePromise`,
      // which would turn it into a plain Promise without `withRawResponse()`.
      result = Laminar.withSpan(span, () => ({
        value: original.call(this, request, ...rest),
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
      if (streaming && isAsyncIterable(data)) {
        const accumulator = isV2
          ? createV2ChatStreamAccumulator()
          : createV1ChatStreamAccumulator();
        instrumentStream(data, span, accumulator, isV2, traceContent);
        return data;
      }
      safely(() =>
        setResponseAttributes(span, data, requestType, isV2, traceContent),
      );
      span.end();
      return data;
    };
    const rethrow = (error: unknown) => {
      fail(error);
      throw error;
    };

    if (
      typeof result?.withRawResponse === "function" &&
      typeof result.constructor?.fromPromise === "function"
    ) {
      // `HttpResponsePromise`: rebuild it around the traced `{ data,
      // rawResponse }` promise so the caller keeps `withRawResponse()`.
      return result.constructor.fromPromise(
        result
          .withRawResponse()
          .then((raw: any) => ({ ...raw, data: succeed(raw?.data) }), rethrow),
      );
    }
    if (typeof result?.then === "function") {
      return result.then(succeed, rethrow);
    }
    return succeed(result);
  };

/**
 * Aggregate the events of an SDK `Stream` as the caller iterates it, and end
 * the span when iteration finishes, fails, or is abandoned early.
 */
const instrumentStream = (
  stream: any,
  span: LaminarSpan,
  accumulator: ChatStreamAccumulator,
  isV2: boolean,
  traceContent: boolean,
): void => {
  const originalIterator = stream[Symbol.asyncIterator].bind(stream);
  let ended = false;
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    safely(() =>
      setResponseAttributes(
        span,
        accumulator.response(),
        "chat",
        isV2,
        traceContent,
      ),
    );
    if (error !== undefined) {
      markSpanError(span, error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  };

  stream[Symbol.asyncIterator] = async function* () {
    const iterable = { [Symbol.asyncIterator]: originalIterator };
    try {
      for await (const event of iterable) {
        safely(() => accumulator.add(event));
        yield event;
      }
    } catch (error) {
      end(error);
      throw error;
    } finally {
      // Normal completion, or the caller stopped iterating early.
      end();
    }
  };
};
