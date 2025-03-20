import { context } from "@opentelemetry/api";

import { observeBase } from './sdk/node-server-sdk';
import { ASSOCIATION_PROPERTIES_KEY } from "./sdk/tracing/tracing";
import { TraceType, TracingLevel } from './types';

interface ObserveOptions {
  name?: string;
  sessionId?: string;
  traceType?: TraceType;
  spanType?: 'DEFAULT' | 'LLM' | 'TOOL';
  traceId?: string;
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
}

/**
 * The main decorator entrypoint for Laminar. This is used to wrap
 * functions and methods to create spans.
 *
 * @param name - Name of the span. Function name is used if not specified.
 * @param sessionId - Session ID to associate with the span and the following context.
 * @param traceType – Type of the trace. Unless it is within evaluation, it should be 'DEFAULT'.
 * @param spanType - Type of the span. 'DEFAULT' is used if not specified. If the type is 'LLM',
 * you must manually specify some attributes. See `Laminar.setSpanAttributes` for more
 * information.
 * @param input - Force override the input for the span. If not specified, the input will be the
 * arguments passed to the function.
 * @param ignoreInput - Whether to ignore the input altogether.
 * @param ignoreOutput - Whether to ignore the output altogether.
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
    traceType,
    spanType,
    traceId,
    input,
    ignoreInput,
    ignoreOutput,
  }: ObserveOptions, fn: F, ...args: A): Promise<ReturnType<F>> {
  if (fn === undefined || typeof fn !== "function") {
    throw new Error("Invalid `observe` usage. Second argument `fn` must be a function.");
  }

  let associationProperties = {};
  if (sessionId) {
    associationProperties = { ...associationProperties, "session_id": sessionId };
  }
  if (traceType) {
    associationProperties = { ...associationProperties, "trace_type": traceType };
  }
  if (spanType) {
    associationProperties = { ...associationProperties, "span_type": spanType };
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return await observeBase<A, F>({
    name: name ?? fn.name,
    associationProperties,
    traceId,
    input,
    ignoreInput,
    ignoreOutput,
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

  const result = context.with(entityContext, () => fn(...args));

  const newAssociationProperties = (
    entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {}
  ) as Record<string, any>;

  for (const key of Object.keys(labelProperties)) {
    delete newAssociationProperties[`label.${key}`];
  }

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    newAssociationProperties,
  );

  return result;
}

/**
 * Sets the tracing level for any spans inside the function. This is useful for
 * conditionally disabling the tracing for certain functions.
 * Tracing level must be one of the values in {@link TracingLevel}. Returns the
 * result of the wrapped function, so you can use it in an `await` statement if
 * needed.
 *
 * @param tracingLevel - The tracing level to set.
 * @returns The result of the wrapped function.
 *
 * @example
 * ```typescript
 * import { withTracingLevel, TracingLevel } from '@lmnr-ai/lmnr';
 *
 * const result = await withTracingLevel(TracingLevel.META_ONLY, () => {
 *    openai.chat.completions.create({});
 * });
 * ```
 */
export function withTracingLevel<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  tracingLevel: TracingLevel,
  fn: F,
  ...args: A
): ReturnType<F> {
  let entityContext = context.active();
  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    { ...currentAssociationProperties, "tracing_level": tracingLevel },
  );

  const result = context.with(entityContext, () => fn(...args));

  const newAssociationProperties = (
    entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {}
  ) as Record<string, any>;
  delete newAssociationProperties["tracing_level"];

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    newAssociationProperties,
  );

  return result;
}
