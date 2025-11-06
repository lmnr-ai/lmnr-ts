import { AttributeValue, context, type Span, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

import { LaminarSpanContext } from "../../types";
import {
  deserializeLaminarSpanContext,
  initializeLogger,
  isOtelAttributeValueType,
  tryToOtelSpanContext,
} from "../../utils";
import { getTracer, shouldSendTraces } from ".";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "./attributes";
import {
  LaminarContextManager,
} from "./context";

const logger = initializeLogger();

export type DecoratorConfig = {
  name: string;
  associationProperties?: Record<string, AttributeValue>;
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
    associationProperties,
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

  return context.with(entityContext, () =>
    getTracer().startActiveSpan(
      name,
      {
        attributes: associationProperties,
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

        // ================================
        Object.entries(associationProperties || {}).forEach(([key, value]) => {
          if (isOtelAttributeValueType(value)) {
            span.setAttribute(key, value);
          } else {
            span.setAttribute(key, JSON.stringify(value));
          }
        });

        let res: ReturnType<F>;
        try {
          res = fn.apply(thisArg as ThisParameterType<F>, args);
        } catch (error) {
          span.recordException(error as Error);
          span.end();
          throw error;
        }

        if (res instanceof Promise) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return res.then((resolvedRes) => {
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      output[key] = normalizePayload(value, seen);
    });
    return output;
  }

  return payload;
};

const serialize = (payload: unknown): string =>
  JSON.stringify(normalizePayload(payload, new WeakSet()));
