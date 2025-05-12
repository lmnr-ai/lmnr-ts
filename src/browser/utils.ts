import { LLMClient } from "@browserbasehq/stagehand";
import path from "path";
import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";
import { fileURLToPath } from "url";
import { z } from "zod";

import { LaminarClient } from "..";
import { initializeLogger, StringUUID } from "../utils";

const logger = initializeLogger();

export const getDirname = () => {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }

  if (typeof import.meta?.url !== 'undefined') {
    return path.dirname(fileURLToPath(import.meta.url));
  }

  return process.cwd();
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
export const cleanStagehandLLMClient = (llmClient: LLMClient | {}): Omit<LLMClient, "client"> =>
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


export const prettyPrintZodSchema = (schema: z.AnyZodObject): string => {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('Not a Zod object schema');
  }

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
        // If it's already nullable, we need to apply optional to the nullable version
        if (result.endsWith('.nullable()')) {
          result = result.replace('.nullable()', '.nullish()');
        } else {
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

    let baseType = getBaseType(value as z.ZodTypeAny);
    const finalType = applyModifiers(value as z.ZodTypeAny, baseType);

    return `  ${key}: ${finalType},`;
  });

  return `z.object({\n${reconstructed.join('\n')}\n})`;
};
