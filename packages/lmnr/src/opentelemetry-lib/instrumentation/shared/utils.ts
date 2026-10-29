/**
 * Helpers shared by the library instrumentations: setting attributes and
 * recording errors without breaking the user's call, and tracing SDK calls
 * and streams while keeping the objects the SDK returns.
 */
import { errorMessage } from "@lmnr-ai/types";
import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import { initializeLogger, toJson } from "../../../utils";

const logger = initializeLogger();

/**
 * Set an attribute unless the value is `null`, `undefined`, an empty string
 * or an empty array.
 */
export const safeSetAttribute = (
  span: Span,
  key: string,
  value: unknown,
): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && value.length === 0) return;
  if (Array.isArray(value) && value.length === 0) return;
  span.setAttribute(key, value as any);
};

/**
 * `error` itself if it is an `Error`. Anything else becomes an `Error` whose
 * message is the value's `message` field, the string itself, or its JSON.
 */
export const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  const message = (error as any)?.message;
  if (typeof message === "string") return new Error(message);
  if (typeof error === "string") return new Error(error);
  return new Error(toJson(error) ?? errorMessage(error));
};

/**
 * Mark a span failed: `error.type`, an `exception` event and an ERROR status
 * with the error's message (see `toError` for non-`Error` values).
 * `setStatus(ERROR)` alone doesn't mark a span failed in Laminar; the
 * `exception` event does.
 */
export const recordSpanError = (span: Span, error: unknown): void => {
  const exception = toError(error);
  span.setAttribute(
    "error.type",
    error instanceof Error ? error.constructor.name : "Error",
  );
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
};

/**
 * End a span: failed with `error` if one is given, OK otherwise.
 */
export const finishSpan = (span: Span, error?: unknown): void => {
  if (error !== undefined) {
    recordSpanError(span, error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
};

/**
 * Run attribute extraction, which must never break the user's call. A failure
 * is logged at debug level and gives `undefined`.
 */
export const safely = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch (error) {
    logger.debug(`Failed to record span attributes: ${errorMessage(error)}`);
    return undefined;
  }
};

export const isAsyncIterable = (value: unknown): value is AsyncIterable<any> =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as any)[Symbol.asyncIterator] === "function";

/**
 * Run `call` with `span` active, and return what it returns, untouched.
 *
 * `Laminar.withSpan` chains `.catch().finally()` onto a returned promise,
 * which turns an SDK promise subclass (`APIPromise`, `HttpResponsePromise`)
 * into a plain Promise without its helpers, and it records the exception of
 * a throw or rejection. Both the result and a thrown error are boxed past it,
 * so the caller records each error exactly once.
 */
export const callWithSpan = <T>(span: Span, call: () => T): T => {
  const box = Laminar.withSpan(span, (): { value: T } | { error: unknown } => {
    try {
      return { value: call() };
    } catch (error) {
      return { error };
    }
  });
  if ("error" in box) throw box.error;
  return box.value;
};

/**
 * Hand the result of an SDK call to `succeed` (whose return value replaces
 * the result) or `fail`, keeping the type of the returned promise:
 * - `APIPromise` (openai, anthropic): through `_thenUnwrap`, so the caller
 *   keeps `withResponse()` / `asResponse()`. Request failures (HTTP and
 *   connection errors) reject the raw response promise, where `fail` is
 *   attached.
 * - `HttpResponsePromise` (cohere): rebuilt around the traced `{ data,
 *   rawResponse }` promise, so the caller keeps `withRawResponse()`.
 * - any other thenable: through `.then`, rethrowing after `fail`.
 * - a plain value: `succeed` right away.
 */
export const settle = (
  result: any,
  succeed: (data: any) => any,
  fail: (error: unknown) => void,
): any => {
  const rethrow = (error: unknown) => {
    fail(error);
    throw error;
  };
  if (typeof result?._thenUnwrap === "function") {
    const responsePromise =
      typeof result._responseProps === "function"
        ? result._responseProps()
        : result.responsePromise;
    if (typeof responsePromise?.then === "function") {
      responsePromise.then(undefined, fail);
    }
    return result._thenUnwrap(succeed);
  }
  if (
    typeof result?.withRawResponse === "function" &&
    typeof result.constructor?.fromPromise === "function"
  ) {
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
 * Trace an SDK call under `span`. A throw or rejection records the error and
 * ends the span. Otherwise `onSuccess` runs once with the result's data and
 * owns ending the span, right away or once a stream it instruments finishes;
 * what it returns is handed to the caller in place of the data. The returned
 * promise keeps its SDK type (see `settle`).
 */
export const traceCall = (
  span: Span,
  call: () => any,
  onSuccess: (data: any) => any,
): any => {
  let result: any;
  try {
    result = callWithSpan(span, call);
  } catch (error) {
    finishSpan(span, error);
    throw error;
  }

  let settled = false;
  const succeed = (data: any) => {
    if (settled) return data;
    settled = true;
    try {
      return onSuccess(data);
    } catch (error) {
      logger.debug(`Failed to record span attributes: ${errorMessage(error)}`);
      span.end();
      return data;
    }
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    finishSpan(span, error);
  };
  return settle(result, succeed, fail);
};

export interface StreamHooks<T = any> {
  /** Called with each item the caller receives. */
  onEvent?: (event: T) => void;
  /**
   * Called exactly once: when iteration completes (no argument), fails (the
   * error), or the caller stops early (no argument).
   */
  onDone: (error?: unknown) => void;
}

/**
 * Report what the caller pulls from an async iterable to `hooks` as it
 * iterates. The hooks never throw into the caller.
 */
const iterateWithHooks = <T>(
  iterable: AsyncIterable<T>,
  onEvent: StreamHooks<T>["onEvent"],
  finish: (error?: unknown) => void,
): AsyncGenerator<T> =>
  (async function* () {
    try {
      for await (const event of iterable) {
        if (onEvent) safely(() => onEvent(event));
        yield event;
      }
    } catch (error) {
      finish(error);
      throw error;
    } finally {
      // Normal completion, or the caller stopped iterating early.
      finish();
    }
  })();

const onceSafely = (onDone: StreamHooks["onDone"]) => {
  let done = false;
  return (error?: unknown) => {
    if (done) return;
    done = true;
    safely(() => onDone(error));
  };
};

/**
 * A generator that yields what `iterable` yields and reports it to `hooks`.
 * For iterables that are themselves generators (where replacing the iterator
 * would miss a caller calling `next()` directly); SDK stream objects are
 * instrumented in place with `instrumentStream`.
 */
export const traceAsyncIterable = <T>(
  iterable: AsyncIterable<T>,
  { onEvent, onDone }: StreamHooks<T>,
): AsyncGenerator<T> => iterateWithHooks(iterable, onEvent, onceSafely(onDone));

/**
 * Report the events of an SDK stream to `hooks` as the caller iterates it.
 * The stream object itself is kept, so `tee()`, `toReadableStream()`,
 * `controller` and the SDK's stream helpers keep working.
 *
 * openai and anthropic streams iterate through their `iterator` field
 * (`[Symbol.asyncIterator]()` and `tee()` both call it), so that is wrapped
 * when present; otherwise `[Symbol.asyncIterator]` is replaced on the
 * instance. A stream that is never iterated never calls `onDone`.
 */
export const instrumentStream = <T = any>(
  stream: any,
  { onEvent, onDone }: StreamHooks<T>,
): void => {
  const finish = onceSafely(onDone);
  const wrap = (makeIterator: () => AsyncIterator<T>) => () =>
    iterateWithHooks<T>(
      { [Symbol.asyncIterator]: makeIterator },
      onEvent,
      finish,
    );
  if (typeof stream.iterator === "function") {
    stream.iterator = wrap(stream.iterator.bind(stream));
    return;
  }
  stream[Symbol.asyncIterator] = wrap(
    stream[Symbol.asyncIterator].bind(stream),
  );
};
