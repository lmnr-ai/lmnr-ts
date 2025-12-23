import { AttributeValue } from "@opentelemetry/api";

import { observeBase } from './opentelemetry-lib';
import { LaminarContextManager } from "./opentelemetry-lib/tracing/context";
import { ASSOCIATION_PROPERTIES_KEY } from "./opentelemetry-lib/tracing/utils";
import { LaminarSpanContext, RolloutParam, TraceType, TracingLevel } from './types';
import { metadataToAttributes } from "./utils";

declare global {
  var _rolloutFunction: ((...args: any[]) => Promise<any>) | undefined;
  var _rolloutFunctionParams: RolloutParam[] | undefined;
  var _set_rollout_global: boolean;
}

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
export function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
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
  }: ObserveOptions, fn: F, ...args: A): ReturnType<F> {
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


  return observeBase<A, F>({
    name: name ?? fn.name,
    associationProperties,
    input,
    ignoreInput,
    ignoreOutput,
    parentSpanContext,
  }, fn, undefined, ...args);
}

/**
 * Extracts parameter names from a function using regex
 */
function extractParamNames(fn: Function): RolloutParam[] {
  const fnStr = fn.toString();

  // Match function parameters - handles regular functions, arrow functions, async functions
  const paramMatch = fnStr.match(/(?:async\s+)?(?:function\s*)?\(([^)]*)\)|(?:async\s+)?([^=\s]+)\s*=>/);

  if (!paramMatch) {
    return [];
  }

  const paramsStr = paramMatch[1] || paramMatch[2] || '';

  if (!paramsStr.trim()) {
    return [];
  }

  // Split by comma and extract parameter names (simple version - just names, no destructuring)
  const params = paramsStr.split(',').map(param => {
    // Remove default values, type annotations, and whitespace
    const name = param
      .trim()
      .replace(/=.+$/, '') // Remove default values
      .replace(/:.+$/, '') // Remove type annotations
      .replace(/\s+/g, ''); // Remove whitespace

    // Extract just the parameter name (handle simple destructuring by taking the variable name)
    const simpleNameMatch = name.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return simpleNameMatch ? simpleNameMatch[0] : name;
  });

  return params
    .filter(name => name && name.length > 0)
    .map(name => ({ name }));
}

/**
 * Wrapper for agent entry points that supports rollout debugging sessions.
 * This function wraps agent functions to enable caching of LLM responses
 * during debugging sessions with the `npx lmnr serve` CLI command.
 *
 * @param options - Same options as `observe`
 * @param fn - The function to wrap (typically an agent entry point)
 * @param args - Arguments to pass to the function
 * @returns Returns the result of the wrapped function
 *
 * @example
 * ```typescript
 * import { observeRollout } from '@lmnr-ai/lmnr';
 *
 * await observeRollout({ name: 'myAgent' }, async (instruction: string) => {
 *    // Your agent code here
 * }, 'tell me a joke');
 * ```
 */
export async function observeRollout<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  options: ObserveOptions,
  fn: F,
  ...args: A
): Promise<ReturnType<F>> {
  if (fn === undefined || typeof fn !== "function") {
    throw new Error("Invalid `observeRollout` usage. Second argument `fn` must be a function.");
  }

  // Extract parameter names
  const params = extractParamNames(fn);
  globalThis._rolloutFunctionParams = params;

  // If we're in registration mode, register the function
  if (globalThis._set_rollout_global) {
    globalThis._rolloutFunction = fn as (...args: any[]) => Promise<any>;
  }

  // Always execute the function via observe
  return await observe(options, fn, ...args);
}

/**
 * @deprecated Use `tags` in `observe` or in `Laminar.startSpan`, or `Laminar.setSpanTags` instead.
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
  labels: string[],
  fn: F,
  ...args: A
): ReturnType<F> {
  let entityContext = context.active();
  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};
  const oldLabels = (currentAssociationProperties as Record<string, any>).labels ?? [];
  const newLabels = [...oldLabels, ...labels];

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    {
      ...currentAssociationProperties,
      labels: newLabels,
    },
  );

  const result = context.with(entityContext, () => fn(...args));

  const newAssociationProperties = (
    entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {}
  ) as Record<string, any>;

  entityContext = entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    { ...newAssociationProperties, labels: oldLabels },
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
 * This decorator uses the TypeScript 5.0+ standard decorator syntax.
 *
 * **Important**: Use this decorator only if your `tsconfig.json` does NOT have
 * `experimentalDecorators: true`. If you're using experimental decorators, use
 * {@link observeExperimentalDecorator} instead.
 *
 * This decorator can be used on class methods to automatically create spans.
 *
 * @param config - Configuration for the observe decorator, can be static or a function
 * @returns A method decorator
 *
 * @example
 * ```typescript
 * // In your tsconfig.json, ensure experimentalDecorators is NOT enabled:
 * // {
 * //   "compilerOptions": {
 * //     "experimentalDecorators": false  // or omit this line
 * //   }
 * // }
 *
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
export function observeDecorator<This, Args extends unknown[], Return>(
  config:
    | Partial<ObserveOptions>
    | ((thisArg: This, ...funcArgs: Args) => Partial<ObserveOptions>),
) {
  return function (
    originalMethod: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ) {
    if (context.kind !== 'method') {
      throw new Error(
        `observeDecorator can only be applied to methods. Applied to: ${String(context.name)}`,
      );
    }

    const methodName = String(context.name);

    return function (this: This, ...args: Args): Return {
      let actualConfig: Partial<ObserveOptions>;

      if (typeof config === "function") {
        actualConfig = config(this, ...args);
      } else {
        actualConfig = config;
      }

      const observeName = actualConfig.name ?? methodName;

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

/**
 * Decorator that wraps a method to automatically observe it with Laminar tracing.
 * This decorator uses the legacy experimental decorator syntax
 * (requires `--experimentalDecorators` flag).
 *
 * **Important**: Use this decorator only if your `tsconfig.json` has
 * `experimentalDecorators: true` in the `compilerOptions` section
 * (or if you compile with the `--experimentalDecorators` flag).
 * For TypeScript 5.0+ projects without experimental decorators, use
 * {@link observeDecorator} instead.
 *
 * This decorator can be used on class methods to automatically create spans.
 *
 * Use this only if you need the legacy experimental decorator syntax.
 * @param config - Configuration for the observe decorator, can be static or a function
 * @returns A method decorator
 *
 * @example
 * ```typescript
 * // In your tsconfig.json, ensure experimentalDecorators is enabled:
 * // {
 * //   "compilerOptions": {
 * //     "experimentalDecorators": true
 * //   }
 * // }
 *
 * import { observeExperimentalDecorator } from '@lmnr-ai/lmnr';
 *
 * class MyService {
 *   @observeExperimentalDecorator({ name: 'processData', spanType: 'DEFAULT' })
 *   async processData(input: string) {
 *     // Your code here
 *     return `processed: ${input}`;
 *   }
 *
 *   @observeExperimentalDecorator((thisArg, ...args) => ({
 *     name: `dynamicMethod_${args[0]}`,
 *     sessionId: thisArg.sessionId
 *   }))
 *   async dynamicMethod(id: string) {
 *     // Your code here
 *   }
 * }
 * ```
 */
export function observeExperimentalDecorator(
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
        "observeExperimentalDecorator can only be applied to methods. " +
        `Applied to: ${String(propertyKey)}`,
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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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
