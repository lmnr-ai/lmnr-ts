import type { Span } from "@opentelemetry/api";

import { initializeLogger } from "../../utils";
import {
  consumeAISDKResult,
  consumeAndTeeAsyncIterable,
  consumeAndTeeReadableStream,
  consumeResponse,
  getStream,
} from "../instrumentation/aisdk/utils";
import { shouldSendTraces } from ".";
import {
  SPAN_OUTPUT,
} from "./attributes";

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
 * Consumes a stream result to ensure background processing completes.
 * This is useful in rollout mode where there's no caller to consume the stream.
 * @param result - The result that might be a stream
 * @returns The same result, or accumulated data if it was a stream
 */
export const consumeStreamResult = async (result: unknown): Promise<unknown> => {
  const streamInfo = getStream(result);

  if (streamInfo.type === null) {
    // Not a stream, return as-is
    logger.debug("Result is not a stream, returning as-is");
    return result;
  }

  logger.debug("Result is a stream, consuming...");

  if (streamInfo.type === 'aisdk-result') {
    // For AI SDK results, just await the text property to trigger consumption
    // The background task will handle collecting all data
    try {
      if ('text' in streamInfo.result) {
        await streamInfo.result.text;
      }
    } catch (error) {
      logger.warn("Error consuming AI SDK result stream: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  if (streamInfo.type === 'readable-stream') {
    // Consume the ReadableStream
    const chunks: unknown[] = [];
    try {
      const reader = streamInfo.stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      logger.warn("Error consuming ReadableStream: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
    return { type: 'stream', chunks };
  }

  if (streamInfo.type === 'async-iterable') {
    // Consume the AsyncIterable
    const chunks: unknown[] = [];
    try {
      for await (const chunk of streamInfo.iterable) {
        chunks.push(chunk);
      }
    } catch (error) {
      logger.warn("Error consuming AsyncIterable: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
    return { type: 'async-iterable', chunks };
  }

  if (streamInfo.type === 'response') {
    // Consume the Response body
    try {
      const { chunks, error } = await consumeResponse(streamInfo.response);
      if (error) {
        logger.warn("Error consuming Response: " +
          `${error instanceof Error ? error.message : String(error)}`);
      }
      return { type: 'response', chunks };
    } catch (error) {
      logger.warn("Error consuming Response: " +
        `${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  return result;
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
export const handleStreamResult = <T>(
  originalResult: T,
  streamInfo: ReturnType<typeof getStream>,
  span: Span,
  ignoreOutput: boolean | undefined,
  serialize: (payload: unknown) => string,
): T | ReadableStream<unknown> | AsyncIterable<unknown> | Response => {
  logger.debug(`Handling stream result of type: ${streamInfo.type}`);

  if (streamInfo.type === 'aisdk-result') {
    // For AI SDK results, consume the promise properties in the background
    trackStreamProcessing(async () => {
      logger.debug('Starting background processing for AI SDK result');

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
        logger.debug('Ending span for AI SDK result');
        span.end();
      }
    });

    return originalResult;
  }

  if (streamInfo.type === 'readable-stream') {
    logger.debug('Setting up background processing for ReadableStream');
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
        logger.debug('Ending span for ReadableStream');
        span.end();
      }
    });

    return stream;
  }

  if (streamInfo.type === 'async-iterable') {
    logger.debug('Setting up background processing for AsyncIterable');
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
        logger.debug('Ending span for AsyncIterable');
        span.end();
      }
    });

    return iterable;
  }

  if (streamInfo.type === 'response') {
    logger.debug('Setting up background processing for Response');
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
      try {
        // Create a temporary Response to use consumeResponse helper
        const tempResponse = new Response(stream2);
        const { chunks, error } = await consumeResponse(tempResponse);

        if (shouldSendTraces() && !ignoreOutput) {
          try {
            const output = { type: 'response', chunks };
            span.setAttribute(SPAN_OUTPUT, serialize(output));
          } catch (serError) {
            logger.warn("Failed to serialize response output: " +
              `${serError instanceof Error ? serError.message : String(serError)}`);
          }
        }

        if (error) {
          span.recordException(error as Error);
        }
      } catch (err) {
        span.recordException(err as Error);
      } finally {
        logger.debug('Ending span for Response');
        span.end();
      }
    });

    return newResponse;
  }

  // Should never reach here, but just in case
  logger.warn('Stream type not handled, ending span immediately');
  span.end();
  return originalResult;
};
