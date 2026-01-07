import { AttributeValue, context, type Span, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

import { LaminarSpanContext, TraceType, TracingLevel } from "../../types";
import {
  deserializeLaminarSpanContext,
  initializeLogger,
  tryToOtelSpanContext,
} from "../../utils";
import {
  consumeAISDKResult,
  consumeAndTeeAsyncIterable,
  consumeAndTeeReadableStream,
  getStream,
} from "../instrumentation/aisdk/utils";
import { getTracer, shouldSendTraces } from ".";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "./attributes";
import {
  ASSOCIATION_PROPERTIES_KEY,
  LaminarContextManager,
} from "./context";

const logger = initializeLogger();

// Track pending stream processing promises
const pendingStreamProcessing = new Set<Promise<void>>();

/**
 * Wait for all pending stream processing to complete with a timeout
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
 */
export const waitForPendingStreams = async (timeoutMs: number = 5000): Promise<void> => {
  if (pendingStreamProcessing.size === 0) {
    return;
  }
  logger.debug(`Waiting for ${pendingStreamProcessing.size} pending stream(s)`);

  const initialCount = pendingStreamProcessing.size;
  const pendingPromises = Array.from(pendingStreamProcessing);

  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([
    Promise.allSettled(pendingPromises),
    timeoutPromise,
  ]);

  if (timedOut && pendingStreamProcessing.size > 0) {
    logger.warn(
      `Timeout waiting for ${pendingStreamProcessing.size} pending stream(s) ` +
      `after ${timeoutMs}ms (started with ${initialCount})`,
    );
  }
};

/**
 * Track a background promise and ensure cleanup
 */
const trackStreamProcessing = (task: () => Promise<void>): void => {
  const processingPromise = task().finally(() => {
    pendingStreamProcessing.delete(processingPromise);
  });

  pendingStreamProcessing.add(processingPromise);
};

/**
 * Handles streaming results by consuming the stream in the background
 * while passing through the original result to the caller
 */
const handleStreamResult = (
  originalResult: any,
  streamInfo: ReturnType<typeof getStream>,
  span: Span,
  ignoreOutput: boolean | undefined,
): any => {
  if (streamInfo.type === 'aisdk-result') {
    // For AI SDK results, consume the promise properties in the background
    trackStreamProcessing(async () => {
      let partialOutput: any = {};
      try {
        partialOutput = await consumeAISDKResult(streamInfo.result);

        if (shouldSendTraces() && !ignoreOutput) {
          try {
            span.setAttribute(SPAN_OUTPUT, serialize(partialOutput));
          } catch (error) {
            logger.warn("Failed to serialize AI SDK stream output: " +
              `${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        // Record partial output if we have any
        if (Object.keys(partialOutput).length > 0 && shouldSendTraces() && !ignoreOutput) {
          try {
            span.setAttribute(SPAN_OUTPUT, serialize(partialOutput));
          } catch (serError) {
            logger.warn("Failed to serialize partial AI SDK output: " +
              `${serError instanceof Error ? serError.message : String(serError)}`);
          }
        }
        span.recordException(error as Error);
      } finally {
        span.end();
      }
    });

    return originalResult;
  }

  if (streamInfo.type === 'readable-stream') {
    const { stream, dataPromise } = consumeAndTeeReadableStream(streamInfo.stream);

    // Consume in background
    trackStreamProcessing(async () => {
      try {
        const { chunks, error } = await dataPromise;

        if (shouldSendTraces() && !ignoreOutput) {
          try {
            const output = { type: 'stream', chunks };
            span.setAttribute(SPAN_OUTPUT, serialize(output));
          } catch (serError) {
            logger.warn("Failed to serialize stream output: " +
              `${serError instanceof Error ? serError.message : String(serError)}`);
          }
        }

        if (error) {
          span.recordException(error as Error);
        }
      } finally {
        span.end();
      }
    });

    return stream;
  }

  if (streamInfo.type === 'async-iterable') {
    const { iterable, dataPromise } = consumeAndTeeAsyncIterable(streamInfo.iterable);

    // Consume in background
    trackStreamProcessing(async () => {
      try {
        const { chunks, error } = await dataPromise;

        if (shouldSendTraces() && !ignoreOutput) {
          try {
            const output = { type: 'async-iterable', chunks };
            span.setAttribute(SPAN_OUTPUT, serialize(output));
          } catch (serError) {
            logger.warn("Failed to serialize async iterable output: " +
              `${serError instanceof Error ? serError.message : String(serError)}`);
          }
        }

        if (error) {
          span.recordException(error as Error);
        }
      } finally {
        span.end();
      }
    });

    return iterable;
  }

  if (streamInfo.type === 'response') {
    // For Response objects, extract the body stream and tee it
    const originalResponse = streamInfo.response;

    if (!originalResponse.body) {
      // No body, just return as-is and end span
      span.end();
      return originalResult;
    }

    const [stream1, stream2] = originalResponse.body.tee();

    // Create a new Response with the teed stream for the caller
    const newResponse = new Response(stream1, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: originalResponse.headers,
    });

    // Consume the other stream in background
    trackStreamProcessing(async () => {
      const chunks: string[] = [];
      let error: any = undefined;

      try {
        const reader = stream2.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }

        if (shouldSendTraces() && !ignoreOutput) {
          try {
            const output = { type: 'response', chunks };
            span.setAttribute(SPAN_OUTPUT, serialize(output));
          } catch (serError) {
            logger.warn("Failed to serialize response output: " +
              `${serError instanceof Error ? serError.message : String(serError)}`);
          }
        }
      } catch (err) {
        error = err;
        span.recordException(error as Error);
      } finally {
        span.end();
      }
    });

    return newResponse;
  }

  // Should never reach here, but just in case
  span.end();
  return originalResult;
};

export type DecoratorConfig = {
  name: string;
  contextProperties?: {
    userId?: string;
    sessionId?: string;
    rolloutSessionId?: string;
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
          return handleStreamResult(res, streamInfo, span, ignoreOutput) as ReturnType<F>;
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
