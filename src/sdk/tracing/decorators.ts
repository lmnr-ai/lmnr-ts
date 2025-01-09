import { Span, TraceFlags, context, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getTracer,
} from "./tracing";
import { shouldSendTraces } from ".";
import { OVERRIDE_PARENT_SPAN, SPAN_INPUT, SPAN_OUTPUT } from "./attributes";
import { isStringUUID, uuidToOtelTraceId } from "../../utils";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";

export type DecoratorConfig = {
  name: string;
  associationProperties?: { [name: string]: string };
  inputParameters?: unknown[];
  suppressTracing?: boolean;
  traceId?: string;
};

export function withEntity<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  {
    name,
    associationProperties,
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

        if (shouldSendTraces()) {
          try {
            const input = inputParameters ?? args;
            if (
              input.length === 1 &&
              typeof input[0] === "object" &&
              !(input[0] instanceof Map)
            ) {
              span.setAttribute(
                SPAN_INPUT,
                serialize(input[0]),
              );
            } else {
              // pass an array of the arguments without names
              // Need to convert it to hashmap from argument name to value, if we figure out how to do it elegantly
              span.setAttribute(
                SPAN_INPUT,
                serialize(input.length > 0 ? input : {}),
              );
            }
          } catch (error) {
            console.warn("Failed to serialize input", error);
          }
        }

        // Remove span type from association properties after the span is created
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
          return res.then((resolvedRes) => {
            try {
              if (shouldSendTraces()) {
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

            return resolvedRes;
          })
          .catch((error) => {
            span.recordException(error as Error);
            span.end();
            throw error;
          });
        }
        try {
          if (shouldSendTraces()) {
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

function cleanInput(input: unknown): unknown {
  if (input instanceof Map) {
    return Array.from(input.entries());
  } else if (Array.isArray(input)) {
    return input.map((value) => cleanInput(value));
  } else if (!input) {
    return input;
  } else if (typeof input === "object") {
    // serialize object one by one
    const output: any = {};
    Object.entries(input as any).forEach(([key, value]) => {
      output[key] = cleanInput(value);
    });
    return output;
  }

  return input;
}

function serialize(input: unknown): string {
  return JSON.stringify(cleanInput(input));
}
