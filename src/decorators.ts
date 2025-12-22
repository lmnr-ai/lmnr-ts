import { AttributeValue } from "@opentelemetry/api";

import { observeBase } from './opentelemetry-lib';
import {
  ASSOCIATION_PROPERTIES,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_TYPE,
  TRACE_TYPE,
  USER_ID,
} from "./opentelemetry-lib/tracing/attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  LaminarContextManager,
} from "./opentelemetry-lib/tracing/context";
import { LaminarSpanContext, TraceType, TracingLevel } from './types';
import { deserializeLaminarSpanContext, initializeLogger, metadataToAttributes } from "./utils";

const logger = initializeLogger();

interface ObserveOptions {
  name?: string;
  sessionId?: string;
  userId?: string;
  traceType?: TraceType;
  spanType?: 'DEFAULT' | 'LLM' | 'TOOL' | 'EVALUATOR' | 'EVALUATION' | 'EXECUTOR';
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
  parentSpanContext?: string | LaminarSpanContext;
  metadata?: Record<string, any>;
  tags?: string[];
}

/**
 * The main decorator entrypoint for Laminar. This is used to wrap
 * functions and methods to create spans.
 *
 * @param name - Name of the span. Function name is used if not specified.
 * @param sessionId - Session ID to associate with the span and the following context.
 * @param userId - User ID to associate with the span and the following context.
 * This is different from the id of a Laminar user.
 * @param traceType – Type of the trace. Unless it is within evaluation, it should be 'DEFAULT'.
 * @param spanType - Type of the span. 'DEFAULT' is used if not specified. If the type is 'LLM',
 * you must manually specify some attributes. See `Laminar.setSpanAttributes` for more
 * information.
 * @param input - Force override the input for the span. If not specified, the input will be the
 * arguments passed to the function.
 * @param ignoreInput - Whether to ignore the input altogether.
 * @param ignoreOutput - Whether to ignore the output altogether.
 * @param metadata - Metadata to add to a trace for further filtering. Must be JSON serializable.
 * @param tags - Tags to associate with the span.
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
    input,
    ignoreInput,
    ignoreOutput,
    parentSpanContext,
    metadata,
    tags,
  }: ObserveOptions, fn: F, ...args: A): Promise<ReturnType<F>> {
  if (fn === undefined || typeof fn !== "function") {
    throw new Error("Invalid `observe` usage. Second argument `fn` must be a function.");
  }

  const associationProperties = buildAssociationProperties({
    sessionId,
    traceType,
    spanType,
    userId,
    tags,
    metadata,
    parentSpanContext,
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return await observeBase<A, F>({
    name: name ?? fn.name,
    associationProperties,
    input,
    ignoreInput,
    ignoreOutput,
    parentSpanContext,
  }, fn, undefined, ...args);
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
  let entityContext = LaminarContextManager.getContext();
  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    { ...currentAssociationProperties, "tracing_level": tracingLevel },
  );

  const result = LaminarContextManager.runWithIsolatedContext(
    [entityContext],
    () => fn(...args),
  );

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

const buildAssociationProperties = (options: Partial<ObserveOptions>):
Record<string, AttributeValue> => {
  const associationProperties: Record<string, AttributeValue> = {};
  const parentSpanContext = options.parentSpanContext;
  const globalMetadata = LaminarContextManager.getGlobalMetadata();
  let parentPath: string[] | undefined;
  let parentIdsPath: string[] | undefined;
  let parentMetadata: Record<string, any> | undefined;
  let parentTraceType: TraceType | undefined;
  let parentTracingLevel: TracingLevel | undefined;
  let parentUserId: string | undefined;
  let parentSessionId: string | undefined;
  const ctxAssociationProperties = LaminarContextManager.getAssociationProperties();

  if (parentSpanContext) {
    try {
      const laminarContext = typeof parentSpanContext === 'string'
        ? deserializeLaminarSpanContext(parentSpanContext)
        : parentSpanContext;

      parentPath = laminarContext.spanPath;
      parentIdsPath = laminarContext.spanIdsPath;
      parentMetadata = laminarContext.metadata;
      parentTraceType = laminarContext.traceType;
      parentTracingLevel = laminarContext.tracingLevel;
      parentUserId = laminarContext.userId;
      parentSessionId = laminarContext.sessionId;
    } catch (e) {
      logger.warn("Failed to parse parent span context: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  const sessionIdValue = options.sessionId ?? parentSessionId ?? ctxAssociationProperties.sessionId;
  if (sessionIdValue) {
    associationProperties[SESSION_ID] = sessionIdValue;
  }
  const userIdValue = options.userId ?? parentUserId ?? ctxAssociationProperties.userId;
  if (userIdValue) {
    associationProperties[USER_ID] = userIdValue;
  }
  const traceTypeValue = options.traceType ?? parentTraceType
    ?? (["EVALUATION", "EXECUTOR", "EVALUATOR"].includes(options.spanType ?? "DEFAULT")
      ? "EVALUATION"
      : undefined
    )
    ?? ctxAssociationProperties.traceType
    ?? "DEFAULT";
  if (traceTypeValue) {
    associationProperties[TRACE_TYPE] = traceTypeValue;
  }

  const tracingLevelValue = parentTracingLevel ?? ctxAssociationProperties.tracingLevel;
  if (tracingLevelValue) {
    associationProperties[`${ASSOCIATION_PROPERTIES}.tracing_level`] = tracingLevelValue;
  }

  if (options.spanType) {
    associationProperties[SPAN_TYPE] = options.spanType;
  }
  if (options.tags) {
    associationProperties[`${ASSOCIATION_PROPERTIES}.tags`] = Array.from(new Set(options.tags));
  }

  const mergedMetadata = {
    ...globalMetadata,
    ...ctxAssociationProperties.metadata,
    ...parentMetadata,
    ...options.metadata,
  };

  const metadataProperties = metadataToAttributes(mergedMetadata);
  return {
    ...associationProperties,
    ...metadataProperties,
    ...(parentPath ? { [PARENT_SPAN_PATH]: parentPath } : {}),
    ...(parentIdsPath ? { [PARENT_SPAN_IDS_PATH]: parentIdsPath } : {}),
  };
};

/**
 * Decorator that wraps a method to automatically observe it with Laminar tracing.
 * This decorator can be used on class methods to automatically create spans.
 *
 * @param config - Configuration for the observe decorator, can be static or a function
 * @returns A method decorator
 *
 * @example
 * ```typescript
 * import { observeDecorator } from '@lmnr-ai/lmnr';
 *
 * class MyService {
 *   @observeDecorator({ name: 'processData', spanType: 'DEFAULT' })
 *   async processData(input: string) {
 *     // Your code here
 *     return `processed: ${input}`;
 *   }
 *
 *   @observeDecorator((thisArg, ...args) => ({
 *     name: `dynamicMethod_${args[0]}`,
 *     sessionId: thisArg.sessionId
 *   }))
 *   async dynamicMethod(id: string) {
 *     // Your code here
 *   }
 * }
 * ```
 */
export function observeDecorator(
  config:
    | Partial<ObserveOptions>
    | ((thisArg: unknown, ...funcArgs: unknown[]) => Partial<ObserveOptions>),
) {
  return function (
    _target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    if (!descriptor || typeof descriptor.value !== 'function') {
      throw new Error(
        `observeDecorator can only be applied to methods. Applied to: ${String(propertyKey)}`,
      );
    }

    const originalMethod = descriptor.value;

    descriptor.value = function (...args: unknown[]) {
      let actualConfig: Partial<ObserveOptions>;

      if (typeof config === "function") {
        actualConfig = config(this, ...args);
      } else {
        actualConfig = config;
      }

      const observeName = actualConfig.name ?? originalMethod.name;

      return observeBase(
        {
          name: observeName,
          associationProperties: buildAssociationProperties(actualConfig),
          input: actualConfig.input,
          ignoreInput: actualConfig.ignoreInput,
          ignoreOutput: actualConfig.ignoreOutput,
          parentSpanContext: actualConfig.parentSpanContext,
        },
        originalMethod,
        this,
        ...args,
      );
    };
  };
}
