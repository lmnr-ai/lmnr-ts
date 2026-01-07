import { type LanguageModelV3Message, type LanguageModelV3Prompt } from "@ai-sdk/provider";
import { type LanguageModelV2Message, type LanguageModelV2Prompt } from "@ai-sdk/provider-v2";
import { type DataContent } from "ai";

// Mirrors https://github.com/vercel/ai/blob/main/packages/ai/src/telemetry/stringify-for-telemetry.ts
// This function is initially implemented by us, and is not exported from the ai sdk.
// We copy it here for our own use.
export const stringifyPromptForTelemetry =
  (prompt: LanguageModelV2Prompt | LanguageModelV3Prompt): string =>
    JSON.stringify(
      prompt.map((message: LanguageModelV2Message | LanguageModelV3Message) => ({
        ...message,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(part =>
              part.type === 'file'
                ? {
                  ...part,
                  data:
                    part.data instanceof Uint8Array
                      ? convertDataContentToBase64String(part.data)
                      : part.data,
                }
                : part,
            ),
      })),
    );

// https://github.com/vercel/ai/blob/main/packages/ai/src/prompt/data-content.ts
/**
Converts data content to a base64-encoded string.

@param content - Data content to convert.
@returns Base64-encoded string.
*/
const convertDataContentToBase64String = (content: DataContent): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return convertUint8ArrayToBase64(new Uint8Array(content));
  }

  return convertUint8ArrayToBase64(content);
};

// https://github.com/vercel/ai/blob/main/packages/provider-utils/src/uint8-utils.ts
export function convertUint8ArrayToBase64(array: Uint8Array): string {
  let latin1string = '';

  // Note: regular for loop to support older JavaScript versions that
  // do not support for..of on Uint8Array
  for (let i = 0; i < array.length; i++) {
    latin1string += String.fromCodePoint(array[i]);
  }

  return btoa(latin1string);
}

/**
 * Information about a detected stream
 */
export type StreamInfo =
  | { type: 'aisdk-result'; result: any }
  | { type: 'readable-stream'; stream: ReadableStream<unknown> }
  | { type: 'async-iterable'; iterable: AsyncIterable<unknown> }
  | { type: 'response'; response: Response }
  | { type: null };

/**
 * This function checks if an object is stream or stream-like, and returns information
 * about the stream type and how to handle it.
 * @param response - The result of a function, either an AI SDK result, a raw stream, or any other
 * response.
 * @returns - StreamInfo object describing the stream type, or { type: null } if not a stream.
 */
export const getStream = (response: unknown): StreamInfo => {
  if (!response || typeof response !== 'object') {
    return { type: null };
  }

  // Check for AI SDK StreamTextResult (has textStream or fullStream property)
  if ('textStream' in response || 'fullStream' in response) {
    return { type: 'aisdk-result', result: response };
  }

  // Check for Response object (from createUIMessageStreamResponse, createTextStreamResponse, etc.)
  if (response instanceof Response) {
    return { type: 'response', response };
  }

  // Check for ReadableStream
  if (response instanceof ReadableStream) {
    return { type: 'readable-stream', stream: response };
  }

  // Check for AsyncIterable (but not ReadableStream, which also implements AsyncIterable)
  if (Symbol.asyncIterator in response && !(response instanceof ReadableStream)) {
    return { type: 'async-iterable', iterable: response as AsyncIterable<unknown> };
  }

  return { type: null };
};

/**
 * Consumes an AI SDK StreamTextResult and returns structured output
 * @param result - The AI SDK StreamTextResult object
 * @returns Promise that resolves to structured output with all relevant fields
 */
export const consumeAISDKResult = async (result: any): Promise<any> => {
  const output: any = {};
  const errors: any[] = [];

  // Helper to safely await a promise property
  const safeAwait = async (key: string, promise: PromiseLike<any>) => {
    try {
      output[key] = await promise;
    } catch (error) {
      errors.push({ field: key, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Collect all the promise properties in parallel
  const promises: Promise<void>[] = [];

  if ('text' in result) promises.push(safeAwait('text', result.text));
  if ('toolCalls' in result) promises.push(safeAwait('toolCalls', result.toolCalls));
  if ('reasoning' in result) promises.push(safeAwait('reasoning', result.reasoning));
  if ('finishReason' in result) promises.push(safeAwait('finishReason', result.finishReason));
  if ('usage' in result) promises.push(safeAwait('usage', result.usage));
  if ('files' in result) promises.push(safeAwait('files', result.files));
  if ('sources' in result) promises.push(safeAwait('sources', result.sources));

  await Promise.all(promises);

  if (errors.length > 0) {
    output._errors = errors;
  }

  return output;
};

/**
 * Consumes a ReadableStream while teeing it to pass through to the caller
 * @param stream - The ReadableStream to consume
 * @returns Object with the teed stream for the caller and a promise for the collected data
 */
export const consumeAndTeeReadableStream = <T>(
  stream: ReadableStream<T>,
): { stream: ReadableStream<T>; dataPromise: Promise<{ chunks: T[]; error?: any }> } => {
  const [stream1, stream2] = stream.tee();

  const dataPromise = (async () => {
    const chunks: T[] = [];
    let error: any = undefined;

    try {
      const reader = stream2.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      error = err;
    }

    return { chunks, error };
  })();

  return { stream: stream1, dataPromise };
};

/**
 * Consumes an AsyncIterable while yielding items to the caller
 * @param iterable - The AsyncIterable to consume
 * @returns Object with a wrapped iterable for the caller and a promise for the collected data
 */
export const consumeAndTeeAsyncIterable = <T>(
  iterable: AsyncIterable<T>,
): { iterable: AsyncIterable<T>; dataPromise: Promise<{ chunks: T[]; error?: any }> } => {
  const chunks: T[] = [];
  let error: any = undefined;
  let resolveData!: (value: { chunks: T[]; error?: any }) => void;
  const dataPromise = new Promise<{ chunks: T[]; error?: any }>((resolve) => {
    resolveData = resolve;
  });

  const wrappedIterable = (async function* () {
    try {
      for await (const item of iterable) {
        chunks.push(item);
        yield item;
      }
    } catch (err) {
      error = err;
      throw err;
    } finally {
      resolveData({ chunks, error });
    }
  })();

  return { iterable: wrappedIterable, dataPromise };
};

/**
 * Consumes a Response object's body stream
 * @param response - The Response object to consume
 * @returns Promise that resolves to the consumed data
 */
export const consumeResponse = async (response: Response):
Promise<{ chunks: any[]; error?: any }> => {
  const chunks: any[] = [];
  let error: any = undefined;

  if (!response.body) {
    return { chunks };
  }

  try {
    const reader = response.body.getReader();
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
  } catch (err) {
    error = err;
  }

  return { chunks, error };
};
