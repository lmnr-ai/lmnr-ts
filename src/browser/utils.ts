import { LLMClient } from "@browserbasehq/stagehand";
import { existsSync } from 'fs';
import { readFile } from "fs/promises";
import path from "path";
import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";
import { z } from "zod";

import { LaminarClient } from "..";
import { getDirname, initializeLogger, StringUUID } from "../utils";

export const LMNR_SEND_EVENTS_FUNCTION_NAME = 'lmnrSendEvents';

const logger = initializeLogger();
const RECORDER_SCRIPT_PATH = (() => {
  const fileName = 'record.umd.min.cjs';
  const standardPath = path.join(getDirname(), '..', 'assets', 'recorder', fileName);
  // Fallback paths for different environments and tests
  const fallbackPaths = [
    path.join(getDirname(), '..', '..', 'assets', 'recorder', fileName), // For tests
    path.join(process.cwd(), 'assets', 'recorder', fileName), // Using cwd
    path.join(process.cwd(), '@lmnr-ai/lmnr', 'assets', 'recorder', fileName), // Absolute path
  ];

  try {
    if (existsSync(standardPath)) {
      return standardPath;
    }

    for (const fallbackPath of fallbackPaths) {
      if (existsSync(fallbackPath)) {
        return fallbackPath;
      }
    }

    // If no path exists, return the standard path and let it fail with a clear error
    return standardPath;
  } catch {
    // In case fs.existsSync fails, return the standard path
    return standardPath;
  }
})();

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

export const injectSessionRecorder = async (page: PlaywrightPage | PuppeteerPage) => {
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
    const script = await readFile(RECORDER_SCRIPT_PATH, 'utf8');
    const result = await tryRunScript(async function injectSessionRecorder() {
      await castedPage.evaluate(script);
      return true;
    });
    if (!result) {
      logger.error("Failed to load session recorder");
      return;
    }
    try {
      await castedPage.evaluate(injectScript);
    } catch (error) {
      logger.debug("Failed to inject session recorder: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }
};


// Removes the heavy client prop and the apiKey to avoid security issues
export const cleanStagehandLLMClient = (llmClient: LLMClient | object): Omit<LLMClient, "client"> =>
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
  ) as Omit<LLMClient, "client">;


export const prettyPrintZodSchema = (schema: z.AnyZodObject, indent = 2): string => {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('Not a Zod object schema');
  }

  const indentString = ' '.repeat(indent);

  const shape = schema.shape;
  const entries = Object.entries(shape);

  const reconstructed: string[] = entries.map(([key, value]) => {
    // Base type detection function
    const getBaseType = (val: z.ZodTypeAny): string => {
      if (val instanceof z.ZodString) {
        return 'z.string()';
      }
      if (val instanceof z.ZodNumber) {
        return 'z.number()';
      }
      if (val instanceof z.ZodBoolean) {
        return 'z.boolean()';
      }
      if (val instanceof z.ZodArray) {
        const elementType = val.element;
        if (elementType instanceof z.ZodObject) {
          return `z.array(${prettyPrintZodSchema(elementType)})`;
        } else {
          return `z.array(${getBaseType(elementType)})`;
        }
      }
      if (val instanceof z.ZodObject) {
        return prettyPrintZodSchema(val);
      }
      if (val instanceof z.ZodEnum) {
        // Try to extract enum values
        const enumValues = (val as any)._def?.values;
        if (Array.isArray(enumValues)) {
          return `z.enum([${enumValues.map(v => `'${v}'`).join(', ')}])`;
        }
        return 'z.enum([...])';
      }
      if (val instanceof z.ZodLiteral) {
        const literalValue = (val as any)._def?.value;
        if (typeof literalValue === 'string') {
          return `z.literal('${literalValue}')`;
        }
        return `z.literal(${literalValue})`;
      }
      if (val instanceof z.ZodUnion) {
        const options = (val as any)._def?.options;
        if (Array.isArray(options)) {
          return `z.union([${options.map(getBaseType).join(', ')}])`;
        }
        return 'z.union([...])';
      }
      if (val instanceof z.ZodDate) {
        return 'z.date()';
      }
      if (val instanceof z.ZodRecord) {
        const keyType = (val as any)._def?.keyType;
        const valueType = (val as any)._def?.valueType;

        let keyTypeStr = 'z.string()';
        if (keyType && keyType !== z.string()) {
          keyTypeStr = getBaseType(keyType);
        }

        let valueTypeStr = 'z.any()';
        if (valueType) {
          valueTypeStr = getBaseType(valueType);
        }

        return `z.record(${keyTypeStr}, ${valueTypeStr})`;
      }
      if (val instanceof z.ZodMap) {
        const keyType = (val as any)._def?.keyType;
        const valueType = (val as any)._def?.valueType;

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
      if (val instanceof z.ZodTuple) {
        const items = (val as any)._def?.items;

        if (Array.isArray(items)) {
          const itemsTypeStr = items.map(item => getBaseType(item)).join(', ');
          return `z.tuple([${itemsTypeStr}])`;
        }
        return 'z.tuple([])';
      }
      if (val instanceof z.ZodNullable) {
        return `${getBaseType((val as any)._def.innerType)}.nullable()`;
      }
      if (val instanceof z.ZodOptional) {
        return `${getBaseType((val as any)._def.innerType)}.optional()`;
      }
      // Add more type checks as needed
      return 'z.any()';
    };

    // Check for modifiers and description
    const applyModifiers = (val: z.ZodTypeAny, baseType: string): string => {
      let result = baseType;
      let currentVal = val;

      // Check for .nullable() modifier
      if (currentVal instanceof z.ZodNullable) {
        result = `${getBaseType((currentVal as any)._def.innerType)}.nullable()`;
        currentVal = (currentVal as any)._def.innerType;
      }

      // Check for .optional() modifier
      if (currentVal instanceof z.ZodOptional) {
        if (!result.endsWith('.nullable()')) {
          result = `${getBaseType((currentVal as any)._def.innerType)}.optional()`;
        }
        currentVal = (currentVal as any)._def.innerType;
      }

      // Check for description
      const description = (val as any)?._def?.description;
      if (typeof description === 'string') {
        result += `.describe('${description.replace(/'/g, "\\'")}')`;
      }

      return result;
    };

    const baseType = getBaseType(value as z.ZodTypeAny);
    const finalType = applyModifiers(value as z.ZodTypeAny, baseType);

    return `${indentString}${key}: ${finalType},`;
  });

  return `z.object({\n${reconstructed.join('\n')}\n})`;
};


// copied from https://github.com/browserbase/stagehand/blob/main/lib/llm/LLMProvider.ts#L62
// We should either keep this in sync or replace with a simple heuristic, such as
// if model name starts with `gpt` or `gemini` or `claude`.
export const modelToProviderMap: Record<string, string> = {
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

const injectScript = () => {
  const BATCH_TIMEOUT = 2000; // Flush events batch after 2 seconds
  const MAX_WORKER_PROMISES = 50; // Max concurrent worker promises
  const HEARTBEAT_INTERVAL = 1000; // 1 second

  (window as any).lmnrRrwebEventsBatch = [];

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
    } catch (error) {
      console.warn('Failed to process large object with transferable:', error);
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
    }
  };


  setInterval(cleanupWorker, 5000);

  const isLargeEvent = (type: number) => {
    const LARGE_EVENT_TYPES: number[] = [
      2, // FullSnapshot
      3, // IncrementalSnapshot
    ];

    if (LARGE_EVENT_TYPES.includes(type)) {
      return true;
    }

    return false;
  };

  const sendBatchIfReady = async () => {
    // for some reason, the access with const like window[LMNR_SEND_EVENTS_FUNCTION_NAME]
    // doesn't work, so we explicitly access the property.
    if (
      (window as any).lmnrRrwebEventsBatch.length > 0
      && typeof (window as any).lmnrSendEvents === 'function'
    ) {
      const events = (window as any).lmnrRrwebEventsBatch;
      (window as any).lmnrRrwebEventsBatch = [];

      try {
        console.log("calling exposed function");
        await (window as any).lmnrSendEvents(events);
      } catch (error) {
        console.error('Failed to send events:', error);
      }
    }
  };

  const bufferToBase64 = async (buffer: Uint8Array) => {
    const base64url = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(new Blob([buffer]));
    });

    return base64url.slice(base64url.indexOf(',') + 1);
  };

  // it's fine to retrigger the interval even if the original function is async
  // and still running.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  setInterval(sendBatchIfReady, BATCH_TIMEOUT);

  setInterval(() => {
    (window as any).lmnrRrweb.record.addCustomEvent('heartbeat', {
      title: document.title,
      url: document.URL,
    });
  }, HEARTBEAT_INTERVAL);

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
  });
};
