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
  createStreamState,
  processStreamEvent,
  setRequestAttributes,
  setResponseAttributes,
  setStreamingResponseAttributes,
} from "./utils";

const logger = initializeLogger();

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
    logger.debug(`Failed to set anthropic span attributes: ${String(error)}`);
  }
};

const isAsyncIterable = (value: any): boolean =>
  value !== null &&
  typeof value === "object" &&
  typeof value[Symbol.asyncIterator] === "function";

/**
 * Resolve the `Anthropic` client class from the module namespace, its default
 * export, or the class itself.
 */
const resolveClientClass = (mod: any): any => {
  for (const candidate of [mod?.Anthropic, mod?.default, mod]) {
    if (typeof candidate?.Messages === "function") {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Instruments `@anthropic-ai/sdk`: `messages.create`, `beta.messages.create`
 * and the legacy `completions.create`. `messages.parse()` and
 * `messages.stream()` (and their beta counterparts) delegate to `create`, so
 * they are traced through it without nesting a second span.
 */
export class AnthropicInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("anthropic", config);
  }

  /**
   * Manual instrumentation accepts the `@anthropic-ai/sdk` module namespace
   * or the `Anthropic` class (the module's default export).
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@anthropic-ai/sdk",
        supportedVersions: [">=0.9.1"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) => this.unpatch(moduleExports),
        accepts: (input) => resolveClientClass(input) !== undefined,
      },
    ];
  }

  private patch(moduleExports: any): void {
    const [completions, ...messages] = resourcePrototypes(moduleExports);
    this.wrapMethod(completions, "create", (patched) =>
      wrapCreate(patched, "anthropic.completion"),
    );
    for (const proto of messages) {
      this.wrapMethod(proto, "create", (patched) =>
        wrapCreate(patched, "anthropic.chat"),
      );
    }
  }

  private unpatch(moduleExports: any): void {
    for (const proto of resourcePrototypes(moduleExports)) {
      this.unwrapMethod(proto, "create");
    }
  }
}

/**
 * `[Completions, Messages, Beta.Messages]` prototypes; entries are undefined
 * where the installed SDK version lacks the resource.
 */
const resourcePrototypes = (moduleExports: any): any[] => {
  const client = resolveClientClass(moduleExports);
  return [
    client?.Completions?.prototype,
    client?.Messages?.prototype,
    client?.Beta?.Messages?.prototype,
  ];
};

const wrapCreate = (patched: PatchedMethod, spanName: string) =>
  function (this: any, params: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, params, ...rest);
    }

    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: spanName,
      spanType: "LLM",
    });
    safely(() => setRequestAttributes(span, params, traceContent));

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
      if (params?.stream && isAsyncIterable(data)) {
        ended = true;
        instrumentStream(data, span, traceContent);
        return data;
      }
      ended = true;
      safely(() => setResponseAttributes(span, data, traceContent));
      span.end();
      return data;
    };

    if (typeof result?._thenUnwrap === "function") {
      // `APIPromise`: transform its parsed body in place so the caller keeps
      // `withResponse()` / `asResponse()`. Request failures (HTTP errors,
      // connection errors) reject the raw response promise.
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

/**
 * Aggregate the events of an SDK `Stream` as the caller iterates it, and end
 * the span when iteration finishes. The stream object itself is kept, so
 * `tee()`, `toReadableStream()` and `controller` keep working.
 */
const instrumentStream = (
  stream: any,
  span: LaminarSpan,
  traceContent: boolean,
): void => {
  const originalIterator = stream[Symbol.asyncIterator].bind(stream);
  const state = createStreamState();
  let ended = false;
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    safely(() => setStreamingResponseAttributes(span, state, traceContent));
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
        safely(() => processStreamEvent(state, event));
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
