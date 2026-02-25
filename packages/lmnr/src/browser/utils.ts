import { type SessionRecordingOptions, type StringUUID } from "@lmnr-ai/types";
import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";

import { LaminarClient } from "..";
import { initializeLogger } from "../utils";
import { RECORDER } from "./recorder";

export const LMNR_SEND_EVENTS_FUNCTION_NAME = 'lmnrSendEvents';

const logger = initializeLogger();

interface LmnrWindow extends Window {
  lmnrRrwebEventsBatch: any[];
  lmnrChunkSequence: number;
  lmnrSendInProgress: boolean;
  lmnrStartedRecordingEvents: boolean;
  lmnrRrweb: any;
  lmnrSendEvents: (chunk: any) => void;
}

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

export const takeFullSnapshot = async (
  page: PlaywrightPage | PuppeteerPage,
): Promise<boolean> => await (page as PlaywrightPage).evaluate(() => {
  if ((window as unknown as LmnrWindow).lmnrRrweb) {
    try {
      (window as unknown as LmnrWindow).lmnrRrweb.record.takeFullSnapshot();
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
      typeof (window as unknown as LmnrWindow).lmnrRrweb !== 'undefined',
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
 * @param {SessionRecordingOptions} sessionRecordingOptions - Optional recording options
 * for masking inputs
 * @param {boolean} stringifyCallbackArgs - If true, stringify arguments when calling
 * lmnrSendEvents (for raw CDP bindings).
 */
export const injectScript = (
  sessionRecordingOptions?: SessionRecordingOptions,
  stringifyCallbackArgs?: boolean,
) => {
  const BATCH_TIMEOUT = 2000; // Send events every 2 seconds
  const HEARTBEAT_INTERVAL = 1000;
  const CHUNK_SIZE = 256 * 1024; // 256KB chunks for CDP message limits

  (window as unknown as LmnrWindow).lmnrRrwebEventsBatch = [];
  (window as unknown as LmnrWindow).lmnrChunkSequence = 0;
  (window as unknown as LmnrWindow).lmnrSendInProgress = false;

  // Define a wrapper function that handles stringification based on the parameter
  const sendEvent = stringifyCallbackArgs
    ? (chunk: any) => (window as unknown as LmnrWindow).lmnrSendEvents(JSON.stringify(chunk))
    : (chunk: any) => (window as unknown as LmnrWindow).lmnrSendEvents(chunk);

  // Gzip compress a string using CompressionStream API (main thread, no workers)
  const gzipCompress = async (str: string): Promise<Uint8Array<ArrayBuffer>> => {
    const encoder = new TextEncoder();
    const inputBytes = encoder.encode(str);

    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    // TODO: investigate why the events are not sent if we await the write and close
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    writer.write(inputBytes);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    writer.close();

    const parts = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      totalLength += value.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  };

  // Convert a Uint8Array to base64 string
  const bufferToBase64 = async (buffer: Uint8Array<ArrayBuffer>): Promise<string> => {
    const base64url = await new Promise<string>((r) => {
      const reader = new FileReader();
      reader.onload = () => r(reader.result as string);
      reader.readAsDataURL(new Blob([buffer]));
    });
    return base64url.slice(base64url.indexOf(',') + 1);
  };

  // Create chunks from a string with metadata
  const createChunks = (str: string, batchId: string): EventChunk[] => {
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

  const sendBatchIfReady = async () => {
    if ((window as unknown as LmnrWindow).lmnrRrwebEventsBatch.length === 0) {
      return;
    }
    if (typeof (window as unknown as LmnrWindow).lmnrSendEvents !== 'function') {
      return;
    }
    // Prevent overlapping sends - if previous send is still in progress,
    // events stay in the batch and will be picked up next interval
    if ((window as unknown as LmnrWindow).lmnrSendInProgress) {
      return;
    }

    (window as unknown as LmnrWindow).lmnrSendInProgress = true;
    const events = (window as unknown as LmnrWindow).lmnrRrwebEventsBatch;
    (window as unknown as LmnrWindow).lmnrRrwebEventsBatch = [];

    try {
      // Compress each event's data field individually
      const compressedEvents = [];
      for (const event of events) {
        try {
          const dataString = JSON.stringify(event.data);
          const compressed = await gzipCompress(dataString);
          const base64Data = await bufferToBase64(compressed);
          compressedEvents.push({
            ...event,
            data: base64Data,
          });
        } catch (e) {
          console.error('Failed to compress event:', e);
        }
      }

      const batchId = `${Date.now()}_${(window as unknown as LmnrWindow).lmnrChunkSequence++}`;
      const batchString = JSON.stringify(compressedEvents);

      if (batchString.length <= CHUNK_SIZE) {
        sendEvent({
          batchId: batchId,
          chunkIndex: 0,
          totalChunks: 1,
          data: batchString,
          isFinal: true,
        });
      } else {
        const chunks = createChunks(batchString, batchId);
        for (const chunk of chunks) {
          sendEvent(chunk);
        }
      }
    } catch (error) {
      console.error('Failed to send events:', error);
    } finally {
      (window as unknown as LmnrWindow).lmnrSendInProgress = false;
    }
  };

  if (!(window as unknown as LmnrWindow).lmnrStartedRecordingEvents) {
    // It's fine to retrigger the interval even if the original function
    // is async and still running.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setInterval(sendBatchIfReady, BATCH_TIMEOUT);

    (window as unknown as LmnrWindow).lmnrRrweb.record({
      emit(event: any) {
        // Synchronous emit - just push to batch, no async processing.
        // Compression happens later in sendBatchIfReady.
        (window as unknown as LmnrWindow).lmnrRrwebEventsBatch.push(event);
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

    // Heartbeat events to indicate the session is still alive
    setInterval(
      () => {
        (window as unknown as LmnrWindow).lmnrRrweb.record.addCustomEvent('heartbeat', {
          title: document.title,
          url: document.URL,
        });
      },
      HEARTBEAT_INTERVAL,
    );

    (window as unknown as LmnrWindow).lmnrStartedRecordingEvents = true;
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
