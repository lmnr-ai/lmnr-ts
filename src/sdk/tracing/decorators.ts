import { context, Span, trace, TraceFlags } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";

import { isStringUUID, uuidToOtelTraceId } from "../../utils";
import { shouldSendTraces } from ".";
import { OVERRIDE_PARENT_SPAN, SPAN_INPUT, SPAN_OUTPUT } from "./attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getTracer,
} from "./tracing";

export type DecoratorConfig = {
  name: string;
  associationProperties?: { [name: string]: string };
  input?: unknown;
  ignoreInput?: boolean;
  ignoreOutput?: boolean;
  inputParameters?: unknown[];
  suppressTracing?: boolean;
  traceId?: string;
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
    traceId,
  }: DecoratorConfig,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
) {
  let entityContext = context.active();

  const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY);

  if (associationProperties) {
    entityContext = entityContext.setValue(
      ASSOCIATION_PROPERTIES_KEY,
      { ...(currentAssociationProperties ?? {}), ...associationProperties },
    );
  }

  if (traceId) {
    if (isStringUUID(traceId)) {
      const spanContext = {
        traceId: uuidToOtelTraceId(traceId),
        spanId: new RandomIdGenerator().generateSpanId(),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      };
      entityContext = trace.setSpanContext(entityContext, spanContext);
    } else {
      console.warn(`Invalid trace ID ${traceId}. Expected a UUID.`);
    }
  }

  if (shouldSuppressTracing) {
    entityContext = suppressTracing(entityContext);
  }

  return context.with(entityContext, () =>
    getTracer().startActiveSpan(
      name,
      {},
      entityContext,
      async (span: Span) => {
        if (traceId && isStringUUID(traceId)) {
          span.setAttribute(OVERRIDE_PARENT_SPAN, true);
        }

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
            console.warn("Failed to serialize input", error);
          }
        }

        // Remove span type from association properties after the span is created
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { "span_type": spanType, ...rest } = associationProperties ?? {};
        entityContext = entityContext.setValue(
          ASSOCIATION_PROPERTIES_KEY,
          { ...(currentAssociationProperties ?? {}), ...rest },
        );

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
              console.warn("Failed to serialize async output", error);
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
          console.warn("Failed to serialize output", error);
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
