import { context, diag, SpanStatusCode } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";
import {
  ChatStreamAccumulator,
  createV1ChatStreamAccumulator,
  createV2ChatStreamAccumulator,
  RequestType,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

const logger = initializeLogger();

const PATCH_DATA_SYMBOL = Symbol("lmnr.cohere.patchData");

type MethodSpec = {
  method: string;
  requestType: RequestType;
  streaming: boolean;
};

type MethodPatchData = MethodSpec & {
  isV2: boolean;
  traceContent: boolean;
  original: (...args: any[]) => any;
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

// Patch data lives on the exact prototype it wraps, never an inherited one.
const ownPatchData = (
  proto: any,
): Record<string, MethodPatchData> | undefined =>
  Object.getOwnPropertyDescriptor(proto, PATCH_DATA_SYMBOL)?.value;

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
export class CohereInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/cohere-instrumentation", SDK_VERSION, {
      enabled: true,
    });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "cohere-ai",
      [">=7.0.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  /**
   * Accepts the `cohere-ai` module namespace (`import * as cohere from
   * "cohere-ai"`) or its default export.
   */
  public manuallyInstrument(module: any): void {
    if (!resolveModule(module)) {
      diag.warn(
        "Could not find CohereClient in cohere manual instrumentation " +
          "input. Pass the cohere-ai module.",
      );
      return;
    }
    diag.debug("Manually instrumenting cohere-ai");
    this.patch(module);
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching cohere-ai");
    for (const { proto, specs, isV2 } of this.targets(moduleExports)) {
      for (const spec of specs) {
        this.patchMethod(definingPrototype(proto, spec.method), spec, isV2);
      }
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching cohere-ai");
    for (const { proto, specs } of this.targets(moduleExports)) {
      for (const { method } of specs) {
        const owner = definingPrototype(proto, method);
        const patched = owner && ownPatchData(owner);
        if (!patched?.[method]) continue;
        owner[method] = patched[method].original;
        delete patched[method];
      }
    }
  }

  private targets(
    moduleExports: any,
  ): { proto: any; specs: MethodSpec[]; isV2: boolean }[] {
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
  }

  /**
   * Replace `proto[method]` with a traced wrapper. Re-patching an already
   * patched method only refreshes `traceContent`, so repeated initialization
   * never double-wraps.
   */
  private patchMethod(proto: any, spec: MethodSpec, isV2: boolean): void {
    if (!proto) return;

    let patched = ownPatchData(proto);
    if (patched?.[spec.method]) {
      patched[spec.method].traceContent = this.traceContent;
      return;
    }
    if (!patched) {
      patched = {};
      Object.defineProperty(proto, PATCH_DATA_SYMBOL, {
        value: patched,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }

    const patchData: MethodPatchData = {
      ...spec,
      isV2,
      traceContent: this.traceContent,
      original: proto[spec.method],
    };
    patched[spec.method] = patchData;
    proto[spec.method] = wrapMethod(patchData);
  }
}

const wrapMethod = (patchData: MethodPatchData) =>
  function (this: any, request: any, ...rest: any[]) {
    const { original, requestType, streaming, isV2 } = patchData;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, ...rest);
    }

    const traceContent = patchData.traceContent;
    const span = Laminar.startSpan({
      name: SPAN_NAMES[requestType],
      spanType: "LLM",
    }) as LaminarSpan;
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
