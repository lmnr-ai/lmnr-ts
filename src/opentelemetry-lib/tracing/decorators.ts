import { AttributeValue, context, type Span, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

import { LaminarSpanContext, TraceType, TracingLevel } from "../../types";
import {
  deserializeLaminarSpanContext,
  initializeLogger,
  tryToOtelSpanContext,
} from "../../utils";
import { getStream } from "../instrumentation/aisdk/utils";
import { getTracer, shouldSendTraces } from ".";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "./attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  LaminarContextManager,
} from "./context";
import { handleStreamResult } from "./stream-utils";

const logger = initializeLogger();

export { consumeStreamResult, waitForPendingStreams } from "./stream-utils";

export type DecoratorConfig = {
  name: string;
  contextProperties?: {
    userId?: string;
    sessionId?: string;
    traceType?: TraceType;
    tracingLevel?: TracingLevel;
    metadata?: Record<string, any>;
  };
  spanAttributes?: Record<string, AttributeValue>;
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
  inputParameters?: unknown[];
  suppressTracing?: boolean;
  parentSpanContext?: string | LaminarSpanContext;
};

// Overload for when thisArg is provided (method call)
export function observeBase<
  A extends unknown[],
  This,
  F extends (this: This, ...args: A) => ReturnType<F>,
>(
  config: DecoratorConfig,
  fn: F,
  thisArg: This,
  ...args: A
): ReturnType<F>;

// Overload for when thisArg is not provided (standalone function)
export function observeBase<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  config: DecoratorConfig,
  fn: F,
  thisArg: undefined,
  ...args: A
): ReturnType<F>;

// Implementation signature (more permissive to handle both cases)
export function observeBase<
  A extends unknown[],
  F extends (this: ThisParameterType<F>, ...args: A) => ReturnType<F>,
>(
  {
    name,
    contextProperties,
    spanAttributes,
    input,
    ignoreInput,
    ignoreOutput,
    inputParameters,
    suppressTracing: shouldSuppressTracing,
    parentSpanContext,
  }: DecoratorConfig,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
): ReturnType<F> {
  let entityContext = LaminarContextManager.getContext();

  if (shouldSuppressTracing) {
    entityContext = suppressTracing(entityContext);
  }

  if (parentSpanContext) {
    try {
      const laminarContext = typeof parentSpanContext === 'string'
        ? deserializeLaminarSpanContext(parentSpanContext)
        : parentSpanContext;

      const spanContext = tryToOtelSpanContext(laminarContext);
      entityContext = trace.setSpan(entityContext, trace.wrapSpanContext(spanContext));
    } catch (e) {
      logger.warn("Failed to parse parent span context: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // Set context properties for propagation to child spans
  if (contextProperties && Object.keys(contextProperties).length > 0) {
    const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY) ?? {};
    entityContext = entityContext.setValue(
      ASSOCIATION_PROPERTIES_KEY,
      { ...currentAssociationProperties, ...contextProperties },
    );
  }

  return context.with(entityContext, () =>
    getTracer().startActiveSpan(
      name,
      {
        attributes: spanAttributes,
      },
      entityContext,
      (span: Span) => {
        if (shouldSendTraces() && !ignoreInput) {
          try {
            const spanInput = inputParameters ?? args;
            if (input !== undefined) {
              span.setAttribute(
                SPAN_INPUT,
                typeof input === 'string' ? input : serialize(input),
              );
            } else if (
              spanInput.length === 1 &&
              typeof spanInput[0] === "object" &&
              !(spanInput[0] instanceof Map)
            ) {
              span.setAttribute(
                SPAN_INPUT,
                typeof spanInput[0] === 'string' ? spanInput[0] : serialize(spanInput[0]),
              );
            } else {
              // pass an array of the arguments without names
              // Need to convert it to map from argument name to value,
              // if we figure out how to do it elegantly
              span.setAttribute(
                SPAN_INPUT,
                serialize(spanInput.length > 0 ? spanInput : {}),
              );
            }
          } catch (error) {
            logger.warn("Failed to serialize input: " +
              `${error instanceof Error ? error.message : String(error)}`);
          }
        }

        let res: ReturnType<F>;
        try {
          res = fn.apply(thisArg as ThisParameterType<F>, args);
        } catch (error) {
          span.recordException(error as Error);
          span.end();
          throw error;
        }

        if (res instanceof Promise) {
          return res.then((resolvedRes) => {
            // Check if the resolved result is a stream
            const streamInfo = getStream(resolvedRes);
            if (streamInfo.type !== null) {
              return handleStreamResult(
                resolvedRes,
                streamInfo,
                span,
                ignoreOutput,
                serialize,
              ) as ReturnType<F>;
            }

            // Not a stream, handle normally
            try {
              if (shouldSendTraces() && !ignoreOutput) {
                span.setAttribute(
                  SPAN_OUTPUT,
                  serialize(resolvedRes),
                );
              }
            } catch (error) {
              logger.warn("Failed to serialize async output: " +
                `${error instanceof Error ? error.message : String(error)}`);
            } finally {
              span.end();
            }

            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return resolvedRes;
          })
            .catch((error) => {
              span.recordException(error as Error);
              span.end();
              throw error;
            }) as ReturnType<F>;
        }

        // Check if the result is a stream
        const streamInfo = getStream(res);
        if (streamInfo.type !== null) {
          return handleStreamResult(
            res, streamInfo, span, ignoreOutput, serialize) as ReturnType<F>;
        }

        try {
          if (shouldSendTraces() && !ignoreOutput) {
            span.setAttribute(
              SPAN_OUTPUT,
              typeof res === 'string' ? res : serialize(res),
            );
          }
        } catch (error) {
          logger.warn("Failed to serialize output: " +
            `${error instanceof Error ? error.message : String(error)}`);
        } finally {
          span.end();
        }

        return res;
      },
    ),
  );
}

const normalizePayload = (payload: unknown, seen: WeakSet<any>): unknown => {
  if (payload instanceof Map) {
    return Array.from(payload.entries());
  } else if (Array.isArray(payload)) {
    return payload.map((value) => normalizePayload(value, seen));
  } else if (!payload) {
    return payload;
  } else if (typeof payload === "object") {
    if (seen.has(payload)) {
      return "[Circular reference]";
    }
    seen.add(payload);

    // serialize object one by one
    const output: any = {};
    Object.entries(payload as any).forEach(([key, value]) => {

      output[key] = normalizePayload(value, seen);
    });
    return output;
  }

  return payload;
};

const serialize = (payload: unknown): string =>
  JSON.stringify(normalizePayload(payload, new WeakSet()));
