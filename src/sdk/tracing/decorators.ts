import { Span, context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getSpanPath,
  getTracer,
  SPAN_PATH_KEY,
} from "./tracing";
import { shouldSendTraces } from ".";
import { SPAN_INPUT, SPAN_OUTPUT } from "./attributes";

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

  const currentSpanPath = getSpanPath(entityContext);
  const spanPath = currentSpanPath ? `${currentSpanPath}.${name}` : name;
  entityContext = entityContext.setValue(SPAN_PATH_KEY, spanPath);

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

        const res = fn.apply(thisArg, args);

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
