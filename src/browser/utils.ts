import { LLMClient } from "@browserbasehq/stagehand";
import path from "path";
import pino from "pino";
import { Page } from "playwright";
import { fileURLToPath } from "url";

import { LaminarClient } from "..";
import { StringUUID } from "../utils";

const logger = pino({
  level: "info",
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

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
  page: Page, // Playwright (or mb puppeteer) page with an async `evaluate` method
  sessionId: StringUUID,
  traceId: StringUUID,
) => {
  try {
    if (page.isClosed()) {
      return;
    }

    const hasFunction = await page.evaluate(
      () => typeof (window as any).lmnrGetAndClearEvents === 'function',
    );
    if (!hasFunction) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const events = await page.evaluate(async () => await (window as any).lmnrGetAndClearEvents());
    if (events == null || events.length === 0) {
      return;
    }

    await client.browserEvents.send({
      sessionId,
      traceId,
      events,
    });
  } catch (error) {
    logger.error(`Error sending events: ${error instanceof Error ? error.message : String(error)}`);
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
