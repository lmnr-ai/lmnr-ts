import { diag, Span, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import type * as PlaywrightLib from "playwright";
import type { Browser, BrowserContext, Page } from 'playwright';

import { version as SDK_VERSION } from "../../package.json";
import { LaminarClient } from '../client';
import { observe } from '../decorators';
import { Laminar } from '../laminar';
import { TRACE_HAS_BROWSER_SESSION } from '../opentelemetry-lib/tracing/attributes';
import { LaminarContextManager } from '../opentelemetry-lib/tracing/context';
import { SessionRecordingOptions } from '../types';
import { initializeLogger, newUUID, NIL_UUID, otelTraceIdToUUID, StringUUID } from '../utils';
import {
  injectSessionRecorder,
  LMNR_SEND_EVENTS_FUNCTION_NAME,
  sendPageEvents,
  takeFullSnapshot,
} from "./utils";

const logger = initializeLogger();

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type
*/
export class PlaywrightInstrumentation extends InstrumentationBase {
  private _patchedBrowsers: Set<Browser> = new Set();
  private _parentSpans: Map<StringUUID, Span> = new Map();
  private _client: LaminarClient;
  private _sessionRecordingOptions?: SessionRecordingOptions;

  constructor(client: LaminarClient, sessionRecordingOptions?: SessionRecordingOptions) {
    super(
      "@lmnr/playwright-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
    );
    this._client = client;
    this._sessionRecordingOptions = sessionRecordingOptions;
  }

  // It's the caller's responsibility to ensure the span is ended
  public setParentSpanForSession(sessionId: StringUUID, span: Span) {
    this._parentSpans.set(sessionId, span);
  }

  public removeAndEndParentSpanForSession(sessionId: StringUUID) {
    const span = this._parentSpans.get(sessionId);
    if (span && span.isRecording()) {
      span.end();
    }
    this._parentSpans.delete(sessionId);
  }

  public getParentSpanForSession(sessionId: StringUUID): Span | undefined {
    return this._parentSpans.get(sessionId);
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "playwright",
      // TODO: test if the older versions work
      ['>=1.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  public manuallyInstrument(pwModule: {
    chromium?: typeof PlaywrightLib.chromium,
    firefox?: typeof PlaywrightLib.firefox,
    webkit?: typeof PlaywrightLib.webkit,
  }) {
    const browsers = [pwModule.chromium, pwModule.firefox, pwModule.webkit] as const;

    for (const browserType of browsers) {
      if (browserType) {
        this._wrap(
          browserType,
          'launch',
          this.patchNewBrowser(),
        );

        this._wrap(
          browserType,
          'connect',
          this.patchNewBrowser(),
        );

        this._wrap(
          browserType,
          'connectOverCDP',
          this.patchNewBrowser(),
        );

        this._wrap(
          browserType,
          'launchPersistentContext',
          this.patchBrowserNewContext(),
        );
      }
    }

    return pwModule;
  }

  private patch(moduleExports: typeof PlaywrightLib, moduleVersion?: string) {
    diag.debug(`patching playwright ${moduleVersion}`);
    const browsers = ['chromium', 'firefox', 'webkit'] as const;

    for (const browserType of browsers) {
      if (moduleExports[browserType]) {
        // First we need to patch the browser launch to get access to the Page class
        this._wrap(
          moduleExports[browserType],
          `launch`,
          this.patchNewBrowser(),
        );

        this._wrap(
          moduleExports[browserType],
          `connect`,
          this.patchNewBrowser(),
        );

        this._wrap(
          moduleExports[browserType],
          'connectOverCDP',
          this.patchNewBrowser(),
        );

        this._wrap(
          moduleExports[browserType],
          'launchPersistentContext',
          this.patchBrowserNewContext(),
        );
      }
    }

    return moduleExports;
  }

  private unpatch(moduleExports: typeof PlaywrightLib, moduleVersion?: string) {
    diag.debug(`unpatching playwright ${moduleVersion}`);
    const browsers = ['chromium', 'firefox', 'webkit'] as const;

    for (const browserType of browsers) {
      if (moduleExports[browserType]) {
        // First we need to patch the browser launch to get access to the Page class
        this._wrap(
          moduleExports[browserType],
          `launch`,
          this.patchNewBrowser(),
        );
      }
    }

    for (const browser of this._patchedBrowsers) {
      this._unwrap(browser, 'newContext');
    }
  }

  private patchNewBrowser() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: any[]) {
      const browser: Browser = await original.call(this, ...args);
      const sessionId = newUUID();

      for (const context of browser.contexts()) {
        context.on('page', (page: Page) => plugin.patchPage(page, sessionId));
        for (const page of context.pages()) {
          await plugin.patchPage(page, sessionId);
        }
      }

      plugin._wrap(
        browser,
        'newContext',
        plugin.patchBrowserNewContext(),
      );

      plugin._patchedBrowsers.add(browser);
      return browser;
    };
  }

  private patchBrowserNewContext() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: unknown[]) {
      const context: BrowserContext = await original.bind(this).apply(this, args);
      const sessionId = newUUID();
      // Patch pages created by browser, e.g. new tab
      context.on('page', async (page) => plugin.patchPage(page, sessionId));

      // Patch pages that are already created
      for (const page of context.pages()) {
        await plugin.patchPage(page, sessionId);
      }

      return context;
    };
  }

  public async patchPage(page: Page, sessionId: StringUUID) {
    const wrapped = async () => {
      // Note: be careful with await here, if the await is removed,
      // this creates a race condition, and playwright fails.
      await observe({ name: 'playwright.page' }, async () => {
        await this._patchPage(page, sessionId);
      });
    };

    const parentSpan = this.getParentSpanForSession(sessionId);
    if (parentSpan) {
      return await Laminar.withSpan(
        parentSpan,
        wrapped,
      );
    }

    return await wrapped();
  }

  private async _patchPage(page: Page, sessionId: StringUUID) {
    const originalBringToFront = page.bringToFront.bind(page);
    page.bringToFront = async () => {
      await originalBringToFront();
      await takeFullSnapshot(page);
    };

    const currentSpan = trace.getSpan(LaminarContextManager.getContext()) ?? trace.getActiveSpan();
    currentSpan?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
    const otelTraceId = currentSpan?.spanContext().traceId;
    const traceId = otelTraceId ? otelTraceIdToUUID(otelTraceId) : NIL_UUID;

    page.on('domcontentloaded', async () => {
      try {
        await injectSessionRecorder(page, this._sessionRecordingOptions);
      } catch (error) {
        logger.error("Error in onLoad handler: " +
          `${error instanceof Error ? error.message : String(error)}`);
      }
    });

    page.on('close', async () => {
      try {
        // Send any remaining events before closing
        await sendPageEvents(this._client, page, sessionId, traceId);
      } catch (error) {
        logger.error("Error in onClose handler: " +
          `${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await injectSessionRecorder(page, this._sessionRecordingOptions);
    try {
      await page.exposeFunction(LMNR_SEND_EVENTS_FUNCTION_NAME, async (events: any[]) => {
        try {
          if (events != null && events.length > 0) {
            await this._client.browserEvents.send({
              sessionId,
              traceId,
              events,
            });
          }
        } catch (error) {
          logger.debug("Could not send events: " +
            `${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } catch (error) {
      logger.debug("Could not expose function " + LMNR_SEND_EVENTS_FUNCTION_NAME + ": " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type
*/
