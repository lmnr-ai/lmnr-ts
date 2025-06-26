import { LLMClient } from "@browserbasehq/stagehand";
import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";
import { z } from "zod";

import { LaminarClient } from "..";
import { initializeLogger, StringUUID } from "../utils";

const logger = initializeLogger();

/**
 * If the first argument is a string, return an object with the name of the method and the argument as the value.
 * Otherwise, return the shallow copy of the arguments.
 *
 * This is useful for Stagehand, where the first argument is often a string, but is named
 * 'instruction', so we add a name to it on the spans.
 *
 * @param args - Args of a function.
 * @param name - The name to add on the first argument if it is a string.
 * @returns The arguments as an object with the name of the method and the argument as the value, or the arguments as is.
 */
export const nameArgsOrCopy = (args: any[], name: string = "instruction") => {
  if (args.length === 1 && typeof args[0] === 'string') {
    return { [name]: args[0] };
  }
  return [...args];
};


export const collectAndSendPageEvents = async (
  client: LaminarClient,
  page: PlaywrightPage | PuppeteerPage,
  sessionId: StringUUID,
  traceId: StringUUID,
) => {
  try {
    if (page.isClosed()) {
      return;
    }

    // Puppeteer pages have the same evaluate method, but Typescript
    // isn't liking that the signature is different.
    const hasFunction = await (page as PlaywrightPage).evaluate(
      () => typeof (window as any).lmnrGetAndClearEvents === 'function',
    );
    if (!hasFunction) {
      return;
    }

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
    } else {
      logger.error(`Error sending events: ${message}`);
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
  "gemini-1.5-flash": "google",
  "gemini-1.5-pro": "google",
  "gemini-1.5-flash-8b": "google",
  "gemini-2.0-flash-lite": "google",
  "gemini-2.0-flash": "google",
  "gemini-2.5-flash-preview-04-17": "google",
  "gemini-2.5-pro-preview-03-25": "google",
};
