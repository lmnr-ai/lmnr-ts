import { context, Span, trace } from "@opentelemetry/api";
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
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
} from "./attributes";
import { LaminarContextManager } from "./context";
import {
  ASSOCIATION_PROPERTIES_KEY,
} from "./utils";

const logger = initializeLogger();

export type DecoratorConfig = {
  name: string;
  associationProperties?: { [name: string]: string };
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
  inputParameters?: unknown[];
  suppressTracing?: boolean;
  parentSpanContext?: string | LaminarSpanContext;
};

export function observeBase<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
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
) {
  let entityContext = LaminarContextManager.getContext();

  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY);

  // span type must not be passed down to the context, so remove it
  const { "span_type": spanType, ...rest } = associationProperties ?? {};
  if (associationProperties) {
    // TODO: Remove this once we've removed older deprecated methods, such as
    // withMetadata, withSession.
    entityContext = entityContext.setValue(
      ASSOCIATION_PROPERTIES_KEY,
      { ...(currentAssociationProperties ?? {}), ...rest },
    );
  }
  // ================================

  let parentPath: string[] | undefined;
  let parentIdsPath: string[] | undefined;

  if (parentSpanContext) {
    try {
      const laminarContext = typeof parentSpanContext === 'string'
        ? deserializeLaminarSpanContext(parentSpanContext)
        : parentSpanContext;

      parentPath = laminarContext.spanPath;
      parentIdsPath = laminarContext.spanIdsPath;

      const spanContext = tryToOtelSpanContext(laminarContext);
      entityContext = trace.setSpan(entityContext, trace.wrapSpanContext(spanContext));
    } catch (e) {
      logger.warn("Failed to parse parent span context: " +
        (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  if (shouldSuppressTracing) {
    entityContext = suppressTracing(entityContext);
  }

  return context.with(entityContext, () =>
    getTracer().startActiveSpan(
      name,
      {
        attributes: {
          ...(parentPath ? { [PARENT_SPAN_PATH]: parentPath } : {}),
          ...(parentIdsPath ? { [PARENT_SPAN_IDS_PATH]: parentIdsPath } : {}),
          ...(spanType ? { [SPAN_TYPE]: spanType } : {}),
        },
      },
      entityContext,
      async (span: Span) => {
        if (shouldSendTraces() && !ignoreInput) {
          try {
            const spanInput = inputParameters ?? args;
            if (input !== undefined) {
              span.setAttribute(
                SPAN_INPUT,
                serialize(input),
              );
            } else if (
              spanInput.length === 1 &&
              typeof spanInput[0] === "object" &&
              !(spanInput[0] instanceof Map)
            ) {
              span.setAttribute(
                SPAN_INPUT,
                serialize(spanInput[0]),
              );
            } else {
              // pass an array of the arguments without names
              // Need to convert it to hashmap from argument name to value,
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

        let res: unknown;
        try {
          res = fn.apply(thisArg, args);
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
            });
        }
        try {
          if (shouldSendTraces() && !ignoreOutput) {
            span.setAttribute(
              SPAN_OUTPUT,
              serialize(res),
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
