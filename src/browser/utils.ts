import { LLMClient } from "@browserbasehq/stagehand";
import path from "path";
import pino from "pino";
import pinoPretty from "pino-pretty";
import { Page as PlaywrightPage } from "playwright";
import { Page as PuppeteerPage } from "puppeteer";
import { fileURLToPath } from "url";

import { LaminarClient } from "..";
import { StringUUID } from "../utils";

const logger = pino(pinoPretty({
  colorize: true,
  minimumLevel: "info",
}));

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
      async () => await (window as any).lmnrGetAndClearEvents(),
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
    if (message.includes("Execution context was destroyed")) {
      logger.info(`Tried to flush events from a closed page. Continuing...`);
    } else {
      logger.error(`Error sending events: ${message}`);
    }
  }
};

// Removes the heavy client prop and the apiKey to avoid security issues
export const cleanStagehandLLMClient = (llmClient: LLMClient): Omit<LLMClient, "client"> =>
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
