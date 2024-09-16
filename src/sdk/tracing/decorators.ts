import { Span, context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getTracer,
} from "./tracing";
import {
  SpanAttributes,
} from "@traceloop/ai-semantic-conventions";
import { shouldSendTraces } from ".";
import { Telemetry } from "../telemetry/telemetry";

export type DecoratorConfig = {
  name: string;
  associationProperties?: { [name: string]: string };
  inputParameters?: unknown[];
  suppressTracing?: boolean;
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

  if (shouldSuppressTracing) {
    entityContext = suppressTracing(entityContext);
  }

  return context.with(entityContext, () =>
    getTracer().startActiveSpan(
      name,
      {},
      entityContext,
      async (span: Span) => {
        if (shouldSendTraces()) {
          try {
            const input = inputParameters ?? args;
            if (
              input.length === 1 &&
              typeof input[0] === "object" &&
              !(input[0] instanceof Map)
            ) {
              span.setAttribute(
                SpanAttributes.TRACELOOP_ENTITY_INPUT,
                serialize({ args: [], kwargs: input[0] }),
              );
            } else {
              span.setAttribute(
                SpanAttributes.TRACELOOP_ENTITY_INPUT,
                serialize({
                  args: input,
                  kwargs: {},
                }),
              );
            }
          } catch (error) {
            Telemetry.getInstance().logException(error as any);
          }
        }

        const res = fn.apply(thisArg, args);
        if (res instanceof Promise) {
          return res.then((resolvedRes) => {
            try {
              if (shouldSendTraces()) {
                span.setAttribute(
                  SpanAttributes.TRACELOOP_ENTITY_OUTPUT,
                  serialize(resolvedRes),
                );
              }
            } catch (error) {
              Telemetry.getInstance().logException(error as any);
            } finally {
              span.end();
            }

            return resolvedRes;
          });
        }
        try {
          if (shouldSendTraces()) {
            span.setAttribute(
              SpanAttributes.TRACELOOP_ENTITY_OUTPUT,
              serialize(res),
            );
          }
        } catch (error) {
          Telemetry.getInstance().logException(error as any);
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
