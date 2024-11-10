import { withEntity } from './sdk/node-server-sdk'
import { Laminar } from './laminar';
import { TraceType } from './types';

interface ObserveOptions {
  name?: string;
  sessionId?: string;
  userId?: string;
  traceType?: TraceType;
  spanType?: 'DEFAULT' | 'LLM';
  traceId?: string;
}

/**
 * The main decorator entrypoint for Laminar. This is used to wrap
 * functions and methods to create spans.
 *
 * @param name - Name of the span. Function name is used if not specified.
 * @param userId - User ID to associate with the span and the following context.
 * @param sessionId - Session ID to associate with the span and the following context.
 * @param traceType – Type of the trace. Unless it is within evaluation, it should be 'DEFAULT'.
 * @param spanType - Type of the span. 'DEFAULT' is used if not specified. If the type is 'LLM',
 * you must manually specify some attributes. See {@link Laminar.setSpanAttributes} for more
 * information.
 * @returns Returns the result of the wrapped function.
 * @throws Exception - Re-throws the exception if the wrapped function throws an exception.
 * 
 * @example
 * ```typescript
 * import { observe } from '@lmnr-ai/lmnr';
 * 
 * await observe({ name: 'my_function' }, () => {
 *    // Your code here
 * });
 */
export async function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  {
    name,
    sessionId,
    userId,
    traceType,
    spanType,
    traceId,
  }: ObserveOptions, fn: F, ...args: A): Promise<ReturnType<F>> {
  if (fn === undefined || typeof fn !== "function") {
    throw new Error("Invalid `observe` usage. Second argument `fn` must be a function.");
  }

  let associationProperties = {};
  if (sessionId) {
    associationProperties = { ...associationProperties, "session_id": sessionId };
  }
  if (userId) {
    associationProperties = { ...associationProperties, "user_id": userId };
  }
  if (traceType) {
    associationProperties = { ...associationProperties, "trace_type": traceType };
  }
  if (spanType) {
    associationProperties = { ...associationProperties, "span_type": spanType };
  }

  return await withEntity<A, F>({
    name: name ?? fn.name,
    associationProperties,
    traceId
  }, fn, undefined, ...args);
}
