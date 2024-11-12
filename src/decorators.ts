import { Span, TraceFlags, context, trace } from "@opentelemetry/api";
import { withEntity } from './sdk/node-server-sdk'
import { Laminar } from './laminar';
import { TraceType } from './types';
import { ASSOCIATION_PROPERTIES_KEY } from "./sdk/tracing/tracing";

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

/**
 * Sets the labels for any spans inside the function. This is useful for adding
 * labels to the spans created in the auto-instrumentations. Returns the result
 * of the wrapped function, so you can use it in an `await` statement if needed.
 * 
 * Requirements:
 * - Labels must be created in your project in advance.
 * - Keys must be strings from your label names.
 * - Values must be strings matching the label's allowed values.
 * 
 * @param labels - The labels to set.
 * @returns The result of the wrapped function.
 * 
 * @example
 * ```typescript
 * import { withLabels } from '@lmnr-ai/lmnr';
 * 
 * const result = await withLabels({ endpoint: "ft-openai-<id>" }, () => {
 *    openai.chat.completions.create({});
 * });
 * ```
 */
export function withLabels<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  labels: Record<string, string>,
  fn: F,
  ...args: A
): ReturnType<F> {
  let entityContext = context.active();
  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};
  const labelProperties = Object.entries(labels).reduce((acc, [key, value]) => {
    acc[`label.${key}`] = value;
    return acc;
  }, {} as Record<string, string>);

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    { ...currentAssociationProperties, ...labelProperties },
  );

  const result = context.with(entityContext, () => {
    return fn.apply(undefined, args);
  });

  const newAssociationProperties = (entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {}) as Record<string, any>;
  for (const [key, value] of Object.entries(labelProperties)) {
    delete newAssociationProperties[`label.${key}`];
  }

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    newAssociationProperties,
  );

  return result;
}
