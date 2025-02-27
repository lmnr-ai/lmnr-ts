import { LLMClient, Page as StagehandPage } from "@browserbasehq/stagehand";
import path from "path";
import { Page } from "playwright";
import { fileURLToPath } from "url";

import { version as SDK_VERSION } from '../../package.json';
import { Laminar } from "..";
import { StringUUID } from "../utils";
import { getLangVersion } from "../version";

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
  page: Page & StagehandPage, // Playwright (or mb puppeteer) page with an async `evaluate` method
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
    const events = await page.evaluate(() => (window as any).lmnrGetAndClearEvents());
    if (events == null || events.length === 0) {
      return;
    }

    const source = getLangVersion() ?? 'javascript';

    const payload = {
      sessionId,
      traceId,
      events,
      source,
      sdkVersion: SDK_VERSION,
    };

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${Laminar.getProjectApiKey()}`);
    headers.set('Accept', 'application/json');

    const response = await fetch(
      `${Laminar.getHttpUrl()}/v1/browser-sessions/events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      console.error('Failed to send events:', response.statusText, await response.text());
    }
  } catch (error) {
    console.error('Error sending events:', error);
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
