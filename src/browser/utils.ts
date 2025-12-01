import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";

import { LaminarClient } from "..";
import { SessionRecordingOptions } from "../types";
import { initializeLogger, StringUUID } from "../utils";
import { RECORDER } from "./recorder";

export const LMNR_SEND_EVENTS_FUNCTION_NAME = 'lmnrSendEvents';

const logger = initializeLogger();

/**
 * If the first argument is a string, return an object with the name of the method
 * and the argument as the value.
 * Otherwise, return the shallow copy of the arguments.
 *
 * This is useful for Stagehand, where the first argument is often a string, but is named
 * 'instruction', so we add a name to it on the spans.
 *
 * @param args - Args of a function.
 * @param name - The name to add on the first argument if it is a string.
 * @returns The arguments as an object with the name of the method and the argument
 * as the value, or the arguments as is.
 */
export const nameArgsOrCopy = (args: any[], name: string = "instruction") => {
  if (args.length === 1 && typeof args[0] === 'string') {
    return { [name]: args[0] };
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return [...args];
};


export interface EventChunk {
  batchId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
  isFinal: boolean;
}

export const sendPageEvents = async (
  client: LaminarClient,
  page: PlaywrightPage | PuppeteerPage,
  sessionId: StringUUID,
  traceId: StringUUID,
) => {
  try {
    // Puppeteer pages have the same evaluate method, but TypeScript
    // isn't liking that the signature is different.

    /* eslint-disable @typescript-eslint/no-unsafe-return */
    const events = await (page as PlaywrightPage).evaluate(
      async () => {
        if (typeof (window as any).lmnrGetAndClearEvents !== 'function') {
          return [];
        }
        return await (window as any).lmnrGetAndClearEvents();
      },
    );
    /* eslint-enable @typescript-eslint/no-unsafe-return */
    if (events == null || events.length === 0) {
      return;
    }

    await client.browserEvents.send({
      sessionId,
      traceId,
      events,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Execution context was destroyed")
      || message.includes("Target page, context or browser has been closed")) {
      logger.debug(`Tried to flush events from a closed page. Continuing...`);
    }
  }
};

export const takeFullSnapshot = async (
  page: PlaywrightPage | PuppeteerPage,
): Promise<boolean> => await (page as PlaywrightPage).evaluate(() => {
  if ((window as any).lmnrRrweb) {
    try {
      (window as any).lmnrRrweb.record.takeFullSnapshot();
      return true;
    } catch (error) {
      logger.error("Error taking full snapshot: " +
        `${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  return false;
});

export const injectSessionRecorder = async (
  page: PlaywrightPage | PuppeteerPage,
  sessionRecordingOptions?: SessionRecordingOptions,
) => {
  const tryRunScript = async <R>(
    script: (...args: any[]) => Promise<R>,
    maxAttempts: number = 5,
  ): Promise<R | undefined> => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await script();
      } catch (error) {
        logger.error("Operation " + script.name + " failed: " +
          `${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  // Both Puppeteer and Playwright have a evaluate method, but the types are different
  // and TypeScript is not liking that the signature is different.

  const castedPage = page as PlaywrightPage;

  let isRrwebPresent = false;
  try {
    isRrwebPresent = await castedPage.evaluate(() =>
      typeof (window as any).lmnrRrweb !== 'undefined',
    );
  } catch (error) {
    logger.debug("ailed to check if session recorder is loaded: " +
      `${error instanceof Error ? error.message : String(error)}`);
  }

  // Load rrweb and set up recording
  if (!isRrwebPresent) {
    const result = await tryRunScript(async function injectSessionRecorder() {
      await castedPage.evaluate(RECORDER);
      return true;
    });
    if (!result) {
      logger.error("Failed to load session recorder");
      return;
    }
    try {
      await castedPage.evaluate(injectScript, sessionRecordingOptions);
    } catch (error) {
      logger.debug("Failed to inject session recorder: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }
};


// Removes the heavy client prop and the apiKey to avoid security issues
export const cleanStagehandLLMClient = (llmClient: object): object =>
  Object.fromEntries(
    Object.entries(llmClient)
      .filter(([key]) => key !== "client")
      .map(([key, value]) =>
        key === "clientOptions"
          ? [
            key,
            Object.fromEntries(
              Object.entries(value).filter(([key]) => key !== "apiKey"),
            ),
          ]
          : [key, value],
      ),
  );


// Stagehand uses zod 3.x or 4.x, so we need to support both versions via duck-typing
export const prettyPrintZodSchema = (schema: any, indent = 2): string => {
  // Use duck-typing instead of instanceof to support both Zod v3 and v4
  const def = schema?._def;
  if (!def || def.typeName !== 'ZodObject') {
    throw new Error('Not a Zod object schema');
  }

  const indentString = ' '.repeat(indent);

  const shape = schema.shape;
  const entries = Object.entries(shape);

  const reconstructed: string[] = entries.map(([key, value]) => {
    // Base type detection function using duck-typing
    const getBaseType = (val: any): string => {
      const valDef = val?._def;
      if (!valDef) return 'z.unknown()';

      const typeName = valDef.typeName;

      if (typeName === 'ZodString') {
        return 'z.string()';
      }
      if (typeName === 'ZodNumber') {
        return 'z.number()';
      }
      if (typeName === 'ZodBoolean') {
        return 'z.boolean()';
      }
      if (typeName === 'ZodArray') {
        const elementType = valDef.type;
        if (elementType?._def?.typeName === 'ZodObject') {
          return `z.array(${prettyPrintZodSchema(elementType)})`;
        } else {
          return `z.array(${getBaseType(elementType)})`;
        }
      }
      if (typeName === 'ZodObject') {
        return prettyPrintZodSchema(val);
      }
      if (typeName === 'ZodEnum') {
        const enumValues = valDef.values;
        if (Array.isArray(enumValues)) {
          return `z.enum([${enumValues.map(v => `'${v}'`).join(', ')}])`;
        }
        return 'z.enum([...])';
      }
      if (typeName === 'ZodLiteral') {
        const literalValue = valDef.value;
        if (typeof literalValue === 'string') {
          return `z.literal('${literalValue}')`;
        }
        return `z.literal(${literalValue})`;
      }
      if (typeName === 'ZodUnion') {
        const options = valDef.options;
        if (Array.isArray(options)) {
          return `z.union([${options.map(getBaseType).join(', ')}])`;
        }
        return 'z.union([...])';
      }
      if (typeName === 'ZodDate') {
        return 'z.date()';
      }
      if (typeName === 'ZodRecord') {
        const keyType = valDef.keyType;
        const valueType = valDef.valueType;

        let keyTypeStr = 'z.string()';
        if (keyType && keyType._def?.typeName !== 'ZodString') {
          keyTypeStr = getBaseType(keyType);
        }

        let valueTypeStr = 'z.any()';
        if (valueType) {
          valueTypeStr = getBaseType(valueType);
        }

        return `z.record(${keyTypeStr}, ${valueTypeStr})`;
      }
      if (typeName === 'ZodMap') {
        const keyType = valDef.keyType;
        const valueType = valDef.valueType;

        let keyTypeStr = 'z.any()';
        if (keyType) {
          keyTypeStr = getBaseType(keyType);
        }

        let valueTypeStr = 'z.any()';
        if (valueType) {
          valueTypeStr = getBaseType(valueType);
        }

        return `z.map(${keyTypeStr}, ${valueTypeStr})`;
      }
      if (typeName === 'ZodTuple') {
        const items = valDef.items;

        if (Array.isArray(items)) {
          const itemsTypeStr = items.map(item => getBaseType(item)).join(', ');
          return `z.tuple([${itemsTypeStr}])`;
        }
        return 'z.tuple([])';
      }
      if (typeName === 'ZodNullable') {
        return `${getBaseType(valDef.innerType)}.nullable()`;
      }
      if (typeName === 'ZodOptional') {
        return `${getBaseType(valDef.innerType)}.optional()`;
      }
      // Add more type checks as needed
      return 'z.any()';
    };

    // Check for modifiers and description
    const applyModifiers = (val: any, baseType: string): string => {
      let result = baseType;
      let currentVal = val;

      // Check for .nullable() modifier using duck-typing
      if (currentVal?._def?.typeName === 'ZodNullable') {
        result = `${getBaseType(currentVal._def.innerType)}.nullable()`;
        currentVal = currentVal._def.innerType;
      }

      // Check for .optional() modifier using duck-typing
      if (currentVal?._def?.typeName === 'ZodOptional') {
        if (!result.endsWith('.nullable()')) {
          result = `${getBaseType(currentVal._def.innerType)}.optional()`;
        }
        currentVal = currentVal._def.innerType;
      }

      // Check for description
      const description = val?._def?.description;
      if (typeof description === 'string') {
        result += `.describe('${description.replace(/'/g, "\\'")}')`;
      }

      return result;
    };

    const baseType = getBaseType(value);
    const finalType = applyModifiers(value, baseType);

    return `${indentString}${key}: ${finalType},`;
  });

  return `z.object({\n${reconstructed.join('\n')}\n})`;
};


// copied from https://github.com/browserbase/stagehand/blob/main/lib/llm/LLMProvider.ts#L62
const modelToProviderMap: Record<string, string> = {
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",
  "o4-mini": "openai",
  //prettier-ignore
  "o3": "openai",
  "o3-mini": "openai",
  //prettier-ignore
  "o1": "openai",
  "o1-mini": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4o-2024-08-06": "openai",
  "gpt-4.5-preview": "openai",
  "o1-preview": "openai",
  "claude-3-5-sonnet-latest": "anthropic",
  "claude-3-5-sonnet-20240620": "anthropic",
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-7-sonnet-20250219": "anthropic",
  "claude-3-7-sonnet-latest": "anthropic",
  "cerebras-llama-3.3-70b": "cerebras",
  "cerebras-llama-3.1-8b": "cerebras",
  "groq-llama-3.3-70b-versatile": "groq",
  "groq-llama-3.3-70b-specdec": "groq",
  "moonshotai/kimi-k2-instruct": "groq",
  "gemini-1.5-flash": "google",
  "gemini-1.5-pro": "google",
  "gemini-1.5-flash-8b": "google",
  "gemini-2.0-flash-lite": "google",
  "gemini-2.0-flash": "google",
  "gemini-2.5-flash-preview-04-17": "google",
  "gemini-2.5-pro-preview-03-25": "google",
};

export const modelToProvider = (model: string): string | undefined => {
  const clean = model.toLowerCase().trim();
  if (clean.startsWith("gpt-") || clean.match(/^o\d-/)) {
    return "openai";
  }
  if (clean.startsWith("claude-")) {
    return "anthropic";
  }
  if (clean.startsWith("gemini-")) {
    return "google";
  }
  if (clean.startsWith("cerebras-")) {
    return "cerebras";
  }
  if (clean.startsWith("groq-")) {
    return "groq";
  }
  return modelToProviderMap[clean];
};

/**
 * The session recording inject script function.
 * This function runs in the browser context and sets up rrweb recording.
 * Exported so it can be converted to a string for CDP Runtime.evaluate.
 * @param sessionRecordingOptions - Optional recording options
 * @param stringifyCallbackArgs - If true, stringify arguments when calling
 * lmnrSendEvents (for raw CDP bindings)
 */
export const injectScript = (
  sessionRecordingOptions?: SessionRecordingOptions,
  stringifyCallbackArgs?: boolean,
) => {
  const BATCH_TIMEOUT = 2000; // Send events after 2 seconds
  const MAX_WORKER_PROMISES = 50; // Max concurrent worker promises
  const HEARTBEAT_INTERVAL = 2000;
  const CHUNK_SIZE = 256 * 1024; // 256KB chunks
  const CHUNK_SEND_DELAY = 100; // 100ms delay between chunks

  (window as any).lmnrRrwebEventsBatch = [];
  (window as any).lmnrChunkQueue = [];
  (window as any).lmnrChunkSequence = 0;
  (window as any).lmnrCurrentBatchId = null;

  // Create a Web Worker for heavy JSON processing with chunked processing
  const createCompressionWorker = (): Worker => {
    const workerCode = `
        self.onmessage = async (e) => {
          const { jsonString, buffer, id, useBuffer } = e.data;
          try {
            let dataBytes;
            if (useBuffer && buffer) {
              // Use transferred ArrayBuffer (no copying needed!)
              dataBytes = new Uint8Array(buffer);
            } else {
                // Convert JSON string to bytes
                const textEncoder = new TextEncoder();
                dataBytes = textEncoder.encode(jsonString);
            }

            const compressionStream = new CompressionStream('gzip');
            const writer = compressionStream.writable.getWriter();
            const reader = compressionStream.readable.getReader();

            // TODO: investigate why the events are not sent if we await the 
            // write and close
            writer.write(dataBytes);
            writer.close();

            const chunks = [];
            let totalLength = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLength += value.length;
            }

            const compressedData = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                compressedData.set(chunk, offset);
                offset += chunk.length;
            }

            self.postMessage({ id, success: true, data: compressedData });
          } catch (error) {
            self.postMessage({ id, success: false, error: error.message });
          }
        };
      `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  };

  let compressionWorker: Worker | null = null;
  const workerPromises = new Map();
  let workerId = 0;
  // null = unknown, true = supported, false = blocked by CSP
  let workerSupported: boolean | null = null;

  // Test if workers are supported (not blocked by CSP)
  const testWorkerSupport = () => {
    if (workerSupported !== null) {
      return workerSupported;
    }

    try {
      const testWorker = createCompressionWorker();
      testWorker.terminate();
      workerSupported = true;
      return true;
    } catch (error) {
      console.warn('Web Workers blocked by CSP, will use main thread compression:', error);
      workerSupported = false;
      return false;
    }
  };

  // Cleanup function for worker
  const cleanupWorker = () => {
    if (compressionWorker) {
      compressionWorker.terminate();
      compressionWorker = null;
    }
    workerPromises.clear();
    workerId = 0;
  };

  // Clean up stale promises to prevent memory leaks
  const cleanupStalePromises = () => {
    if (workerPromises.size > MAX_WORKER_PROMISES) {
      const toDelete = [];
      for (const [id, promise] of workerPromises) {
        if (toDelete.length >= workerPromises.size - MAX_WORKER_PROMISES) {
          break;
        }
        toDelete.push(id);
        promise.reject(new Error('Promise cleaned up due to memory pressure'));
      }
      toDelete.forEach(id => workerPromises.delete(id));
    }
  };

  // Non-blocking JSON.stringify using chunked processing
  const stringifyNonBlocking = (
    obj: unknown,
    chunkSize = 10000,
  ): Promise<string> => new Promise((resolve, reject) => {
    try {
      // For very large objects, we need to be more careful
      // Use requestIdleCallback if available, otherwise setTimeout
      const scheduleWork = window.requestIdleCallback ||
        ((cb) => setTimeout(cb, 0));

      let result = '';
      let keys: string[] = [];
      let keyIndex = 0;

      // Pre-process to get all keys if it's an object
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        keys = Object.keys(obj);
      }

      const processChunk = () => {
        try {
          if (Array.isArray(obj) || typeof obj !== 'object' || obj === null) {
            // For arrays and primitives, just stringify directly
            result = JSON.stringify(obj);
            resolve(result);
            return;
          }

          // For objects, process in chunks
          const endIndex = Math.min(keyIndex + chunkSize, keys.length);

          if (keyIndex === 0) {
            result = '{';
          }

          for (let i = keyIndex; i < endIndex; i++) {
            const key = keys[i];
            const value = (obj as Record<string, unknown>)[key];

            if (i > 0) result += ',';
            result += JSON.stringify(key) + ':' + JSON.stringify(value);
          }

          keyIndex = endIndex;

          if (keyIndex >= keys.length) {
            result += '}';
            resolve(result);
          } else {
            // Schedule next chunk
            scheduleWork(processChunk);
          }
        } catch (error) {
          reject(error as Error);
        }
      };

      processChunk();
    } catch (error) {
      reject(error as Error);
    }
  });

  // Fast compression for small objects (main thread)
  const compressSmallObject = async (data: unknown) => {
    const jsonString = JSON.stringify(data);
    const textEncoder = new TextEncoder();
    const bytes = textEncoder.encode(jsonString);

    const compressionStream = new CompressionStream('gzip');
    const writer = compressionStream.writable.getWriter();
    const reader = compressionStream.readable.getReader();

    // TODO: investigate why the events are not sent if we await the write and close
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    writer.write(bytes);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    writer.close();

    const chunks = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    const compressedData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressedData.set(chunk, offset);
      offset += chunk.length;
    }

    return compressedData;
  };

  // Alternative: Use transferable objects for maximum efficiency
  const compressLargeObjectTransferable = async (data: unknown): Promise<Uint8Array> => {
    try {
      if (!testWorkerSupport()) {
        return compressSmallObject(data);
      }

      // Clean up stale promises first
      cleanupStalePromises();

      // Stringify on main thread but non-blocking
      const jsonString = await stringifyNonBlocking(data);

      // Convert to ArrayBuffer (transferable)
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode(jsonString);
      const buffer = uint8Array.buffer; // Use the original buffer for transfer

      return new Promise((resolve, reject) => {
        if (!compressionWorker) {
          compressionWorker = createCompressionWorker();
          compressionWorker.onmessage = (e) => {
            const { id, success, data: result, error } = e.data;
            const promise = workerPromises.get(id);
            if (promise) {
              workerPromises.delete(id);
              if (success) {
                promise.resolve(result);
              } else {
                promise.reject(new Error(error));
              }
            }
          };

          compressionWorker.onerror = (error) => {
            console.error('Compression worker error:', error);
            cleanupWorker();
            compressSmallObject(data).then(resolve, reject);
          };
        }

        const id = ++workerId;
        workerPromises.set(id, { resolve, reject });

        // Set timeout to prevent hanging promises
        setTimeout(() => {
          if (workerPromises.has(id)) {
            workerPromises.delete(id);
            reject(new Error('Compression timeout'));
          }
        }, 10000);

        // Transfer the ArrayBuffer (no copying!)
        compressionWorker.postMessage({
          buffer,
          id,
          useBuffer: true,
        }, [buffer]);
      });
    } catch {
      // Silently fall back to main thread compression
      return compressSmallObject(data);
    }
  };

  // Worker-based compression for large objects
  const compressLargeObject = async (data: unknown): Promise<Uint8Array> => {
    try {
      // Use transferable objects for better performance
      return await compressLargeObjectTransferable(data);
    } catch (error) {
      console.warn('Transferable failed, falling back to string method:', error);
      try {
        // Fallback to string method
        const jsonString = await stringifyNonBlocking(data);

        return new Promise((resolve, reject) => {
          if (!compressionWorker) {
            compressionWorker = createCompressionWorker();
            compressionWorker.onmessage = (e) => {
              const { id, success, data: result, error } = e.data;
              const promise = workerPromises.get(id);
              if (promise) {
                workerPromises.delete(id);
                if (success) {
                  promise.resolve(result);
                } else {
                  promise.reject(new Error(error));
                }
              }
            };

            compressionWorker.onerror = (error) => {
              console.error('Compression worker error:', error);
              cleanupWorker();
            };
          }

          const id = ++workerId;
          workerPromises.set(id, { resolve, reject });

          // Set timeout to prevent hanging promises
          setTimeout(() => {
            if (workerPromises.has(id)) {
              workerPromises.delete(id);
              reject(new Error('Compression timeout'));
            }
          }, 10000);

          compressionWorker.postMessage({ jsonString, id });
        });
      } catch (workerError) {
        logger.warn("Worker creation failed, falling back to main thread compression: " +
          `${workerError instanceof Error ? workerError.message : String(workerError)}`);
        // Final fallback: compress on main thread (may block UI but will work)
        return await compressSmallObject(data);
      }
    }
  };


  setInterval(cleanupWorker, 5000);

  const isLargeEvent = (type: number) => {
    const LARGE_EVENT_TYPES: number[] = [
      2, // FullSnapshot
    ];

    if (LARGE_EVENT_TYPES.includes(type)) {
      return true;
    }

    return false;
  };

  // Create chunks from a string with metadata
  const createChunks = (str: string, batchId: string) => {
    const chunks = [];
    const totalChunks = Math.ceil(str.length / CHUNK_SIZE);

    for (let i = 0; i < str.length; i += CHUNK_SIZE) {
      const chunk = str.slice(i, i + CHUNK_SIZE);
      chunks.push({
        batchId: batchId,
        chunkIndex: chunks.length,
        totalChunks: totalChunks,
        data: chunk,
        isFinal: chunks.length === totalChunks - 1,
      });
    }

    return chunks;
  };

  // Send chunks with flow control
  const sendChunks = async (chunks: any[]) => {
    if (typeof (window as any).lmnrSendEvents !== 'function') {
      return;
    }

    (window as any).lmnrChunkQueue.push(...chunks);

    // Process queue
    while ((window as any).lmnrChunkQueue.length > 0) {
      const chunk = (window as any).lmnrChunkQueue.shift();
      try {
        // CDP bindings require stringified arguments, Playwright/Puppeteer auto-serialize
        const arg = stringifyCallbackArgs ? JSON.stringify(chunk) : chunk;
        await (window as any).lmnrSendEvents(arg);
        // Small delay between chunks to avoid overwhelming CDP
        await new Promise(resolve => setTimeout(resolve, CHUNK_SEND_DELAY));
      } catch (error) {
        console.error('Failed to send chunk:', error);
        // On error, clear failed chunk batch from queue
        (window as any).lmnrChunkQueue = (window as any).lmnrChunkQueue.filter(
          (c: any) => c.batchId !== chunk.batchId,
        );
        break;
      }
    }
  };

  const sendBatchIfReady = async () => {
    if ((window as any).lmnrRrwebEventsBatch.length > 0
      && typeof (window as any).lmnrSendEvents === 'function') {
      const events = (window as any).lmnrRrwebEventsBatch;
      (window as any).lmnrRrwebEventsBatch = [];

      try {
        // Generate unique batch ID
        const batchId = `${Date.now()}_${(window as any).lmnrChunkSequence++}`;
        (window as any).lmnrCurrentBatchId = batchId;

        // Stringify the entire batch
        const batchString = JSON.stringify(events);

        // Check size and chunk if necessary
        if (batchString.length <= CHUNK_SIZE) {
          // Small enough to send as single chunk
          const chunk = {
            batchId: batchId,
            chunkIndex: 0,
            totalChunks: 1,
            data: batchString,
            isFinal: true,
          };
          // CDP bindings require stringified arguments, Playwright/Puppeteer auto-serialize
          const arg = stringifyCallbackArgs ? JSON.stringify(chunk) : chunk;
          await (window as any).lmnrSendEvents(arg);
        } else {
          // Need to chunk
          const chunks = createChunks(batchString, batchId);
          await sendChunks(chunks);
        }
      } catch (error) {
        console.error('Failed to send events:', error);
        // Clear batch to prevent memory buildup
        (window as any).lmnrRrwebEventsBatch = [];
      }
    }
  };

  const bufferToBase64 = async (buffer: Uint8Array) => {
    const base64url = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(new Blob([buffer.slice()]));
    });

    return base64url.slice(base64url.indexOf(',') + 1);
  };

  if (!(window as any).lmnrStartedRecordingEvents) {
    // It's fine to retrigger the interval even if the original function
    // is async and still running.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setInterval(sendBatchIfReady, BATCH_TIMEOUT);

    (window as any).lmnrRrweb.record({
      async emit(event: any) {
        try {
          const isLarge = isLargeEvent(event.type);
          const compressedResult = isLarge ?
            await compressLargeObject(event.data) :
            await compressSmallObject(event.data);

          const base64Data = await bufferToBase64(compressedResult);
          const eventToSend = {
            ...event,
            data: base64Data,
          };
          (window as any).lmnrRrwebEventsBatch.push(eventToSend);
        } catch (error) {
          console.warn('Failed to push event to batch', error);
        }
      },
      recordCanvas: true,
      collectFonts: true,
      recordCrossOriginIframes: true,
      maskInputOptions: {
        password: true,
        textarea: sessionRecordingOptions?.maskInputOptions?.textarea || false,
        text: sessionRecordingOptions?.maskInputOptions?.text || false,
        number: sessionRecordingOptions?.maskInputOptions?.number || false,
        select: sessionRecordingOptions?.maskInputOptions?.select || false,
        email: sessionRecordingOptions?.maskInputOptions?.email || false,
        tel: sessionRecordingOptions?.maskInputOptions?.tel || false,
      },
    });

    function heartbeat() {
      // Add heartbeat events
      setInterval(
        () => {
          (window as any).lmnrRrweb.record.addCustomEvent('heartbeat', {
            title: document.title,
            url: document.URL,
          });
        },
        HEARTBEAT_INTERVAL,
      );
    }

    heartbeat();
    (window as any).lmnrStartedRecordingEvents = true;
  }
};

// Buffer for storing incomplete chunk batches
export interface ChunkBuffer {
  chunks: Map<number, string>;
  total: number;
  timestamp: number;
}

const OLD_BUFFER_TIMEOUT = 60000; // 60 seconds in milliseconds

export async function sendEvents(
  chunk: EventChunk,
  client: LaminarClient,
  chunkBuffers: Map<string, ChunkBuffer>,
  sessionId: StringUUID,
  traceId: StringUUID,
): Promise<void> {
  try {
    // Handle chunked data
    const { batchId, chunkIndex, totalChunks, data } = chunk;

    // Validate required fields
    if (!sessionId || !traceId) {
      logger.debug("Missing sessionId or traceId in chunk");
      return;
    }

    // Initialize buffer for this batch if needed
    if (!chunkBuffers.has(batchId)) {
      chunkBuffers.set(batchId, {
        chunks: new Map(),
        total: totalChunks,
        timestamp: Date.now(),
      });
    }

    const buffer = chunkBuffers.get(batchId)!;

    // Store chunk
    buffer.chunks.set(chunkIndex, data);

    // Check if we have all chunks
    if (buffer.chunks.size === totalChunks) {
      // Reassemble the full message
      let fullData = "";
      for (let i = 0; i < totalChunks; i++) {
        fullData += buffer.chunks.get(i);
      }

      // Parse the JSON
      const events = JSON.parse(fullData) as Record<string, any>[];

      // Send to server
      if (events && events.length > 0) {
        // Fire and forget - don't await to avoid blocking
        await client.browserEvents.send({ sessionId, traceId, events }).catch((error) => {
          logger.debug("Failed to send events: " +
            `${error instanceof Error ? error.message : String(error)}`);
        });
      }

      // Clean up buffer
      chunkBuffers.delete(batchId);
    }

    // Clean up old incomplete buffers
    const currentTime = Date.now();
    const toDelete: string[] = [];

    for (const [bid, buffer] of chunkBuffers.entries()) {
      if (currentTime - buffer.timestamp > OLD_BUFFER_TIMEOUT) {
        toDelete.push(bid);
      }
    }

    for (const bid of toDelete) {
      logger.debug(`Cleaning up incomplete chunk buffer: ${bid}`);
      chunkBuffers.delete(bid);
    }
  } catch (error) {
    logger.debug("Could not send events: " +
      `${error instanceof Error ? error.message : String(error)}`);
  }
}
