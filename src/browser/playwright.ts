import { diag, Span, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import { existsSync } from 'fs';
import { readFile } from "fs/promises";
import path from "path";
import type * as PlaywrightLib from "playwright";
import type { Browser, BrowserContext, Page } from 'playwright';

import { version as SDK_VERSION } from "../../package.json";
import { LaminarClient } from '../client';
import { observe } from '../decorators';
import { Laminar } from '../laminar';
import { TRACE_HAS_BROWSER_SESSION } from '../opentelemetry-lib/tracing/attributes';
import { initializeLogger, newUUID, NIL_UUID, StringUUID } from '../utils';
import { collectAndSendPageEvents, getDirname } from "./utils";

const logger = initializeLogger();

const RRWEB_SCRIPT_PATH = (() => {
  const fileName = 'rrweb.umd.min.cjs';
  const standardPath = path.join(getDirname(), '..', 'assets', 'rrweb', fileName);
  // Fallback paths for different environments and tests
  const fallbackPaths = [
    path.join(getDirname(), '..', '..', 'assets', 'rrweb', fileName), // For tests
    path.join(process.cwd(), 'assets', 'rrweb', fileName), // Using cwd
    path.join(process.cwd(), '@lmnr-ai/lmnr', 'assets', 'rrweb', fileName), // Absolute path
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

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
export class PlaywrightInstrumentation extends InstrumentationBase {
  private _patchedBrowsers: Set<Browser> = new Set();
  private _patchedContexts: Set<BrowserContext> = new Set();
  private _patchedPages: Set<Page> = new Set();
  private _parentSpan: Span | undefined;
  private _client: LaminarClient;

  constructor(client: LaminarClient) {
    super(
      "@lmnr/playwright-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
    );
    this._parentSpan = undefined;
    this._client = client;
  }

  // It's the caller's responsibility to ensure the span is ended
  public setParentSpan(span: Span) {
    this._parentSpan = span;
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
      this._unwrap(browser, 'newPage');
    }
    for (const context of this._patchedContexts) {
      this._unwrap(context, 'newPage');
    }
    for (const page of this._patchedPages) {
      this._unwrap(page, 'close');
    }
  }

  private patchNewBrowser() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: any[]) {
      const browser: Browser = await original.call(this, ...args);
      if (!plugin._parentSpan) {
        plugin._parentSpan = Laminar.startSpan({
          name: 'playwright',
        });
      }

      for (const context of browser.contexts()) {
        await Promise.all(context.pages().map(page => plugin.patchPage(page)));
        plugin._wrap(
          context,
          'newPage',
          plugin.patchBrowserContextNewPage(),
        );
        context.on('page', (page: Page) => plugin.patchPage(page));
        plugin._patchedContexts.add(context);
      }

      plugin._wrap(
        browser,
        'newContext',
        plugin.patchBrowserNewContext(),
      );

      plugin._wrap(
        browser,
        'newPage',
        plugin.patchBrowserNewPage(),
      );

      plugin._wrap(
        browser,
        'close',
        plugin.patchBrowserClose(),
      );

      plugin._patchedBrowsers.add(browser);
      return browser;
    };
  }

  private patchBrowserClose() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: unknown[]) {
      await original.call(this, ...args);
      if (plugin._parentSpan?.isRecording()) {
        plugin._parentSpan?.end();
      }
    };
  }

  private patchBrowserNewContext() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: unknown[]) {
      const context: BrowserContext = await original.bind(this).apply(this, args);
      if (!plugin._parentSpan) {
        plugin._parentSpan = Laminar.startSpan({
          name: 'playwright',
        });
      }
      // Patch pages that are created manually from Playwright
      plugin._wrap(
        context,
        'newPage',
        plugin.patchBrowserContextNewPage(),
      );
      plugin._wrap(
        context,
        'close',
        plugin.patchBrowserContextClose(),
      );
      // Patch pages created by browser, e.g. new tab
      context.on('page', async (page) => plugin.patchPage(page));

      // Patch pages that are already created
      for (const page of context.pages()) {
        await plugin.patchPage(page);
      }

      plugin._patchedContexts.add(context);
      return context;
    };
  }

  private patchBrowserContextClose() {
    const plugin = this;
    return (original: Function) => async function method(this: BrowserContext, ...args: unknown[]) {
      await original.bind(this).apply(this, args);
      if (plugin._parentSpan?.isRecording()) {
        plugin._parentSpan.end();
      }
    };
  }

  private patchBrowserNewPage() {
    return (original: Function) => async function method(this: Browser, ...args: unknown[]) {
      const page = await original.bind(this).apply(this, args);
      if (!page) {
        return null;
      }
      // TODO: investigate why this creates a separate empty span and no events
      // await plugin.patchPage(page);
      return page;
    };
  }

  public patchBrowserContextNewPage() {
    const plugin = this;
    return (original: Function) => async function method(this: BrowserContext, ...args: unknown[]) {
      const page = await original.bind(this).apply(this, args);
      if (!plugin._parentSpan) {
        plugin._parentSpan = Laminar.startSpan({
          name: 'playwright',
        });
      }
      if (!page) {
        return null;
      }

      await plugin.patchPage(page);

      return page;
    };
  }

  public async patchPage(page: Page) {
    return await Laminar.withSpan(this._parentSpan!, async () => {
      // Note: be careful with await here, if the await is removed,
      // this creates a race condition, and playwright fails.
      await observe({ name: 'playwright.page' }, async () => {
        await this._patchPage(page);
      });
    });
  }

  private async _patchPage(page: Page) {
    const originalBringToFront = page.bringToFront.bind(page);
    page.bringToFront = async () => {
      await originalBringToFront();
      await page.evaluate(() => {
        if ((window as any).lmnrRrWeb) {
          try {
            (window as any).lmnrRrWeb.record.takeFullSnapshot();
          } catch (error) {
            console.error("Failed to take full snapshot: " +
              `${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });
    };

    page.addListener("domcontentloaded", (p: Page) => {
      this.injectRrweb(p).catch(error => {
        logger.error("Failed to inject rrweb: " +
          `${error instanceof Error ? error.message : String(error)}`);
      });
    });

    await this.injectRrweb(page);
    this._patchedPages.add(page);

    trace.getActiveSpan()?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);

    const traceId = trace.getActiveSpan()?.spanContext().traceId as StringUUID ?? NIL_UUID;
    const sessionId = newUUID();
    const interval = setInterval(() => {
      if (page.isClosed()) {
        clearInterval(interval);
        return;
      }
      collectAndSendPageEvents(this._client, page, sessionId, traceId)
        .catch(error => {
          logger.error("Event collection stopped: " +
            `${error instanceof Error ? error.message : String(error)}`);
        });
    }, 2000);

    page.addListener('close', async () => {
      clearInterval(interval);
      await collectAndSendPageEvents(this._client, page, sessionId, traceId);
      for (const otherPage of page.context().pages().reverse()) {
        try {
          await otherPage.bringToFront();
          break;
        } catch (error) {
          logger.debug("Failed to bring page to front: " +
            `${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }

  private async injectRrweb(page: Page) {
    // Wait for the page to be in a ready state first
    await page.waitForLoadState('domcontentloaded');
    const tryRunScript = async (
      script: (...args: any[]) => Promise<any>,
      maxAttempts: number = 5,
    ) => {
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

    const isRrwebPresent = await page.evaluate(() =>
      typeof (window as any).lmnrRrweb !== 'undefined',
    );

    // Load rrweb and set up recording
    if (!isRrwebPresent) {
      const script = await readFile(RRWEB_SCRIPT_PATH, 'utf8');
      await tryRunScript(async function injectRrweb() {
        await page.evaluate(script);
        const res = await page.waitForFunction(
          () => 'lmnrRrweb' in window || (window as any).lmnrRrweb,
          {
            timeout: 5000,
          },
        );
        if (!res) {
          throw new Error('Failed to inject rrweb');
        }
      });
    }

    // Update the recording setup to include trace ID
    await tryRunScript(async function setupRrwebCollection() {
      await page.evaluate(() => {
        const HEARTBEAT_INTERVAL = 1000;  // 1 second heartbeat

        (window as any).lmnrRrwebEventsBatch = new Set();

        (window as any).lmnrPageIsFocused = true;
        window.addEventListener('blur', () => {
          (window as any).lmnrPageIsFocused = false;
        });
        window.addEventListener('focus', () => {
          (window as any).lmnrPageIsFocused = true;
        });

        const compressEventData = async (data: any) => {
          const jsonString = JSON.stringify(data);
          const blob = new Blob([jsonString], { type: 'application/json' });
          const compressedStream = blob.stream().pipeThrough(new CompressionStream('gzip'));
          const compressedResponse = new Response(compressedStream);
          const compressedData = await compressedResponse.arrayBuffer();
          return Array.from(new Uint8Array(compressedData));
        };

        (window as any).lmnrGetAndClearEvents = () => {
          const events = (window as any).lmnrRrwebEventsBatch;
          (window as any).lmnrRrwebEventsBatch = new Set();
          return Array.from(events);
        };

        setInterval(() => {
          if (!(window as any).lmnrPageIsFocused) {
            return;
          }
          (window as any).lmnrRrweb.record.addCustomEvent('heartbeat', {
            title: document.title,
            url: document.URL,
          });
        }, HEARTBEAT_INTERVAL);

        (window as any).lmnrRrweb.record({
          async emit(event: any) {
            // Ignore events from all tabs except the current one
            if (!(window as any).lmnrPageIsFocused) {
              return;
            }
            const compressedEvent = {
              ...event,
              data: await compressEventData(event.data),
            };
            (window as any).lmnrRrwebEventsBatch.add(compressedEvent);
          },
        });
      });
    });
  };
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type,
  @typescript-eslint/no-unsafe-return
*/
