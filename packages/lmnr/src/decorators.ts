import { LaminarSpanContext, RolloutParam, TraceType, TracingLevel } from '@lmnr-ai/types';
import { AttributeValue } from "@opentelemetry/api";

import { observeBase } from './opentelemetry-lib';
import {
  ASSOCIATION_PROPERTIES,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SPAN_TYPE,
} from "./opentelemetry-lib/tracing/attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  LaminarContextManager,
} from "./opentelemetry-lib/tracing/context";
import { deserializeLaminarSpanContext, initializeLogger } from "./utils";

const logger = initializeLogger();

declare global {
  var _rolloutFunctions: Map<string, {
    fn: (...args: any[]) => any;
    params: RolloutParam[];
    name: string;
  }> | undefined;
  var _set_rollout_global: boolean;
  var _currentExportName: string | undefined;
}

interface ObserveOptions {
  name?: string;
  sessionId?: string;
  userId?: string;
  rolloutSessionId?: string;
  traceType?: TraceType;
  spanType?: 'DEFAULT' | 'LLM' | 'TOOL' | 'EVALUATOR' | 'EVALUATION' | 'EXECUTOR';
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
  parentSpanContext?: string | LaminarSpanContext;
  metadata?: Record<string, any>;
  tags?: string[];
  rolloutEntrypoint?: boolean;
}

/**
 * Extracts parameter names from a function using regex (fallback for runtime parsing)
 * Note: This is a best-effort fallback. For TypeScript files, use ts-parser.ts instead.
 */
const extractParamNames = (fn: (...args: any[]) => any): RolloutParam[] => {
  const fnStr = fn.toString();

  // Match function parameters - handles regular functions, arrow functions, async functions
  const paramMatch = fnStr.match(
    /(?:async\s+)?(?:function\s*)?\(([^)]*)\)|(?:async\s*)?([^=\s(]+)\s*=>/,
  );

  if (!paramMatch) {
    return [];
  }

  const paramsStr = paramMatch[1] || paramMatch[2] || '';

  if (!paramsStr.trim()) {
    return [];
  }

  // Split by comma and extract parameter names with metadata
  const params = paramsStr.split(',').map(param => {
    const trimmed = param.trim();

    // Check if it's destructured (starts with { or [)
    if (trimmed.startsWith('{')) {
      return {
        name: '_destructured',
        required: !trimmed.includes('='), // Has default if includes =
      };
    }

    if (trimmed.startsWith('[')) {
      return {
        name: '_arrayDestructured',
        required: !trimmed.includes('='),
      };
    }

    // Extract default value if present
    const hasDefault = trimmed.includes('=');
    let defaultValue: string | undefined;
    let nameWithoutDefault = trimmed;

    if (hasDefault) {
      const parts = trimmed.split('=');
      nameWithoutDefault = parts[0].trim();
      defaultValue = parts.slice(1).join('=').trim();
    }

    // Check for optional marker (?)
    const isOptional = nameWithoutDefault.includes('?');

    // Remove type annotations and whitespace
    const name = nameWithoutDefault
      .replace(/:.+$/, '') // Remove type annotations
      .replace(/\?/g, '')  // Remove optional marker
      .replace(/\s+/g, ''); // Remove whitespace

    // Extract just the parameter name
    const simpleNameMatch = name.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    const paramName = simpleNameMatch ? simpleNameMatch[0] : name;

    return {
      name: paramName,
      required: !hasDefault && !isOptional,
      default: defaultValue,
    };
  });

  return params.filter(p => p.name && p.name.length > 0);
};

/**
 * The main decorator entrypoint for Laminar. This is used to wrap
 * functions and methods to create spans.
 *
 * When `rolloutEntrypoint: true` is set, returns a wrapped function that can be
 * used for agent debugging sessions with `npx lmnr serve`.
 *
 * @param options - Configuration options for the span
 * @param options.name - Name of the span. Function name is used if not specified.
 * @param options.sessionId - Session ID to associate with the span and the following context.
 * @param options.userId - User ID to associate with the span and the following context.
 * This is different from the id of a Laminar user.
 * @param options.traceType - Type of the trace. Unless it is within evaluation, it should be
 * 'DEFAULT'.
 * @param options.spanType - Type of the span. 'DEFAULT' is used if not specified. If the type
 * is 'LLM', you must manually specify some attributes. See `Laminar.setSpanAttributes`
 * for more information.
 * @param options.input - Force override the input for the span. If not specified, the
 * input will be the arguments passed to the function.
 * @param options.ignoreInput - Whether to ignore the input altogether.
 * @param options.ignoreOutput - Whether to ignore the output altogether.
 * @param options.parentSpanContext - Parent span context to associate with this span.
 * @param options.metadata - Metadata to add to a trace for further filtering. Must be
 * JSON serializable.
 * @param options.tags - Tags to associate with the span.
 * @param options.rolloutEntrypoint - When true, returns a wrapped function for
 * rollout debugging. When false/undefined, executes the function immediately.
 * @param fn - The function to wrap
 * @param args - Arguments to pass to the function (only when rolloutEntrypoint is
 * false/undefined)
 * @returns Wrapped function (when rolloutEntrypoint: true) or Promise with result
 * @throws Exception - Re-throws the exception if the wrapped function throws an exception.
 *
 * @example
 * ```typescript
 * // Regular usage (immediate execution)
 * await observe({ name: 'my_function' }, async (x: string) => {
 *    // Your code here
 *    return x.toUpperCase();
 * }, 'hello');
 *
 * // Rollout entrypoint (returns wrapped function)
 * export const myAgent = observe(
 *   { name: 'agent', rolloutEntrypoint: true },
 *   async (input: string) => {
 *     // Your agent code here
 *     return processInput(input);
 *   }
 * );
 * // Then call: await myAgent('hello');
 * ```
 */
// Overload: when rolloutEntrypoint is true, return wrapped function
export function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  options: ObserveOptions & { rolloutEntrypoint: true },
  fn: F,
  ...args: A
): F;

export function observe<F extends (...args: any[]) => ReturnType<F>>(
  options: ObserveOptions & { rolloutEntrypoint: true },
  fn: F,
): F;

// Overload: when rolloutEntrypoint is false/undefined, execute immediately
export function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  options: ObserveOptions,
  fn: F,
  ...args: A
): ReturnType<F>;

// Implementation
export function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
  options: ObserveOptions,
  fn: F,
  ...args: A
): F | ReturnType<F> {
  if (fn === undefined || typeof fn !== "function") {
    throw new Error("Invalid `observe` usage. Second argument `fn` must be a function.");
  }

  const {
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
    rolloutEntrypoint,
  } = options;
  const spanName = name ?? fn.name;

  // If rolloutEntrypoint is true, return a wrapped function
  if (rolloutEntrypoint) {
    // Extract parameter names for rollout
    const params = extractParamNames(fn);
    // Get rollout session ID from env var if in rollout mode
    const envRolloutSessionId = process.env.LMNR_ROLLOUT_SESSION_ID;

    // Create wrapped function
    const wrappedFn = ((...fnArgs: Parameters<F>): ReturnType<F> => {
      const observeOptions = {
        sessionId,
        traceType,
        spanType,
        userId,
        rolloutSessionId: envRolloutSessionId,
        tags,
        metadata,
      };

      const contextProperties = buildContextProperties(observeOptions);
      const spanAttributes = buildSpanAttributes(observeOptions);

      const argsToPass = (args && args.length > 0) ? args : fnArgs;

      return observeBase<A, F>({
        name: spanName,
        contextProperties,
        spanAttributes,
        input: input ?? argsToPass,
        ignoreInput,
        ignoreOutput,
        parentSpanContext,
      }, fn, undefined, ...argsToPass);
    }) as F;

    // If in registration mode, register this function
    if (globalThis._set_rollout_global) {
      if (!globalThis._rolloutFunctions) {
        globalThis._rolloutFunctions = new Map();
      }

      // Use current export name if available, otherwise use function name
      const exportName = globalThis._currentExportName || spanName || 'unknown';

      globalThis._rolloutFunctions.set(exportName, {
        fn: wrappedFn as (...args: any[]) => any,
        params,
        name: spanName,
      });
    }

    return wrappedFn;
  }

  // Regular execution mode (backward compatible)
  const observeOptions = {
    sessionId,
    traceType,
    spanType,
    userId,
    tags,
    metadata,
    parentSpanContext,
  };

  const contextProperties = buildContextProperties(observeOptions);
  const spanAttributes = buildSpanAttributes(observeOptions);

  return observeBase<A, F>({
    name: spanName,
    contextProperties,
    spanAttributes,
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

  entityContext.setValue(
    ASSOCIATION_PROPERTIES_KEY,
    newAssociationProperties,
  );

  return result;
}

/**
 * Builds context-level association properties that propagate to child spans.
 * These properties flow through the OpenTelemetry context and are inherited by
 * any child spans created with startActiveSpan.
 */
const buildContextProperties = (
  options: Partial<ObserveOptions>,
): {
  userId?: string;
  sessionId?: string;
  rolloutSessionId?: string;
  traceType?: TraceType;
  tracingLevel?: TracingLevel;
  metadata?: Record<string, any>;
} => {
  const parentSpanContext = options.parentSpanContext;
  const globalMetadata = LaminarContextManager.getGlobalMetadata();
  const ctxAssociationProperties = LaminarContextManager.getAssociationProperties();

  let parentMetadata: Record<string, any> | undefined;
  let parentTraceType: TraceType | undefined;
  let parentTracingLevel: TracingLevel | undefined;
  let parentUserId: string | undefined;
  let parentSessionId: string | undefined;
  let parentRolloutSessionId: string | undefined;

  if (parentSpanContext) {
    try {
      const laminarContext = typeof parentSpanContext === 'string'
        ? deserializeLaminarSpanContext(parentSpanContext)
        : parentSpanContext;

      parentMetadata = laminarContext.metadata;
      parentTraceType = laminarContext.traceType;
      parentTracingLevel = laminarContext.tracingLevel;
      parentUserId = laminarContext.userId;
      parentSessionId = laminarContext.sessionId;
      parentRolloutSessionId = laminarContext.rolloutSessionId;
    } catch (e) {
      logger.warn("Failed to parse parent span context: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  const contextProperties: {
    userId?: string;
    sessionId?: string;
    rolloutSessionId?: string;
    traceType?: TraceType;
    tracingLevel?: TracingLevel;
    metadata?: Record<string, any>;
  } = {};

  const sessionIdValue = options.sessionId ?? parentSessionId ?? ctxAssociationProperties.sessionId;
  if (sessionIdValue) {
    contextProperties.sessionId = sessionIdValue;
  }

  const userIdValue = options.userId ?? parentUserId ?? ctxAssociationProperties.userId;
  if (userIdValue) {
    contextProperties.userId = userIdValue;
  }

  const rolloutSessionIdValue = options.rolloutSessionId ?? parentRolloutSessionId
    ?? ctxAssociationProperties.rolloutSessionId;
  if (rolloutSessionIdValue) {
    contextProperties.rolloutSessionId = rolloutSessionIdValue;
  }

  const traceTypeValue = options.traceType ?? parentTraceType
    ?? (["EVALUATION", "EXECUTOR", "EVALUATOR"].includes(options.spanType ?? "DEFAULT")
      ? "EVALUATION"
      : undefined
    )
    ?? ctxAssociationProperties.traceType
    ?? "DEFAULT";
  if (traceTypeValue) {
    contextProperties.traceType = traceTypeValue;
  }

  const tracingLevelValue = parentTracingLevel ?? ctxAssociationProperties.tracingLevel;
  if (tracingLevelValue) {
    contextProperties.tracingLevel = tracingLevelValue;
  }

  const mergedMetadata = {
    ...globalMetadata,
    ...ctxAssociationProperties.metadata,
    ...parentMetadata,
    ...options.metadata,
    ...(rolloutSessionIdValue ? { 'rollout.session_id': rolloutSessionIdValue } : {}),
  };

  if (Object.keys(mergedMetadata).length > 0) {
    contextProperties.metadata = mergedMetadata;
  }

  return contextProperties;
};

/**
 * Builds span-specific attributes that do NOT propagate to child spans.
 * These include spanType, tags, and parent span path information.
 */
const buildSpanAttributes = (
  options: Partial<ObserveOptions>,
): Record<string, AttributeValue> => {
  const spanAttributes: Record<string, AttributeValue> = {};

  if (options.spanType) {
    spanAttributes[SPAN_TYPE] = options.spanType;
  }

  if (options.tags) {
    spanAttributes[`${ASSOCIATION_PROPERTIES}.tags`] = Array.from(new Set(options.tags));
  }

  if (options.parentSpanContext) {
    try {
      const laminarContext = typeof options.parentSpanContext === 'string'
        ? deserializeLaminarSpanContext(options.parentSpanContext)
        : options.parentSpanContext;

      if (laminarContext.spanPath) {
        spanAttributes[PARENT_SPAN_PATH] = laminarContext.spanPath;
      }
      if (laminarContext.spanIdsPath) {
        spanAttributes[PARENT_SPAN_IDS_PATH] = laminarContext.spanIdsPath;
      }
    } catch (e) {
      logger.warn("Failed to parse parent span context for span attributes: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  return spanAttributes;
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
      const contextProperties = buildContextProperties(actualConfig);
      const spanAttributes = buildSpanAttributes(actualConfig);

      return observeBase(
        {
          name: observeName,
          contextProperties,
          spanAttributes,
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
      const contextProperties = buildContextProperties(actualConfig);
      const spanAttributes = buildSpanAttributes(actualConfig);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return observeBase(
        {
          name: observeName,
          contextProperties,
          spanAttributes,
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
