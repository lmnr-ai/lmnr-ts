import { LaminarClient } from '@lmnr-ai/client';
import { SessionRecordingOptions } from '@lmnr-ai/types';
import { diag, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import type * as PuppeteerLib from "puppeteer";
import type { Browser, BrowserContext, Page } from 'puppeteer';
import type * as PuppeteerCoreLib from "puppeteer-core";

import { version as SDK_VERSION } from "../../package.json";
import { observe } from '../decorators';
import { TRACE_HAS_BROWSER_SESSION } from '../opentelemetry-lib/tracing/attributes';
import { LaminarContextManager } from '../opentelemetry-lib/tracing/context';
import { initializeLogger, newUUID, NIL_UUID, otelTraceIdToUUID, StringUUID } from '../utils';
import {
  ChunkBuffer,
  EventChunk,
  injectSessionRecorder,
  LMNR_SEND_EVENTS_FUNCTION_NAME,
  sendEvents,
  sendPageEvents,
  takeFullSnapshot,
} from "./utils";

const logger = initializeLogger();


/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-function-type
*/
export class PuppeteerInstrumentation extends InstrumentationBase {
  private _patchedBrowsers: Set<Browser> = new Set();
  private _client: LaminarClient;
  private _sessionRecordingOptions?: SessionRecordingOptions;

  constructor(client: LaminarClient, sessionRecordingOptions?: SessionRecordingOptions) {
    super(
      "@lmnr/puppeteer-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
    );
    this._client = client;
    this._sessionRecordingOptions = sessionRecordingOptions;
  }

  protected init(): InstrumentationModuleDefinition[] {
    const puppeteerInstrumentation = new InstrumentationNodeModuleDefinition(
      "puppeteer",
      // About two years before first writing this instrumentation
      // and apparently no big breaking changes afterwards
      // https://github.com/puppeteer/puppeteer/releases
      ['>=19.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    const puppeteerCoreInstrumentation = new InstrumentationNodeModuleDefinition(
      "puppeteer-core",
      ['>=19.0.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return [puppeteerInstrumentation, puppeteerCoreInstrumentation];
  }

  public manuallyInstrument(puppeteerModule: typeof PuppeteerLib | typeof PuppeteerCoreLib) {
    this._wrap(
      puppeteerModule,
      'launch',
      this.patchNewBrowser(),
    );

    this._wrap(
      puppeteerModule,
      'connect',
      this.patchNewBrowser(),
    );

    return puppeteerModule;
  }

  private patch(
    moduleExports: typeof PuppeteerLib | typeof PuppeteerCoreLib,
    moduleVersion?: string,
  ) {
    diag.debug(`patching puppeteer ${moduleVersion}`);
    this._wrap(
      moduleExports,
      `launch`,
      this.patchNewBrowser(),
    );

    this._wrap(
      moduleExports.PuppeteerNode.prototype,
      `launch`,
      this.patchNewBrowser(),
    );

    this._wrap(
      moduleExports,
      `connect`,
      this.patchNewBrowser(),
    );

    this._wrap(
      moduleExports.Puppeteer.prototype,
      `connect`,
      this.patchNewBrowser(),
    );

    this._wrap(
      moduleExports.default,
      `launch`,
      this.patchNewBrowser(),
    );

    this._wrap(
      moduleExports.default,
      `connect`,
      this.patchNewBrowser(),
    );

    return moduleExports;
  }

  private unpatch(moduleExports: typeof PuppeteerLib, moduleVersion?: string) {
    diag.debug(`unpatching puppeteer ${moduleVersion}`);
    this._unwrap(
      moduleExports,
      `launch`,
    );

    this._unwrap(
      moduleExports,
      `connect`,
    );

    this._unwrap(
      moduleExports.PuppeteerNode.prototype,
      `launch`,
    );

    this._unwrap(
      moduleExports.Puppeteer.prototype,
      `connect`,
    );

    this._unwrap(
      moduleExports.default,
      `connect`,
    );

    this._unwrap(
      moduleExports.default,
      `launch`,
    );

    for (const browser of this._patchedBrowsers) {
      this._unwrap(browser, 'createBrowserContext');
    }
  }

  private patchNewBrowser() {
    const plugin = this;
    return (original: Function) => async function method(this: Browser, ...args: any[]) {
      const browser: Browser = await original.call(this, ...args);
      const sessionId = newUUID();

      for (const context of browser.browserContexts()) {
        context.on('targetcreated', (target) => {
          target.page().then(page => {
            if (page) {
              plugin.patchPage(page, sessionId).catch(error => {
                logger.error("Failed to patch page: " +
                  `${error instanceof Error ? error.message : String(error)}`);
              });
            }
          })
            .catch(error => {
              logger.error("Failed to patch page: " +
                `${error instanceof Error ? error.message : String(error)}`);
            });
        });
        await Promise.all((await context.pages()).map(page => plugin.patchPage(page, sessionId)));
      }

      plugin._wrap(
        browser,
        'createBrowserContext',
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
      context.on('targetcreated', (target) => {
        target.page().then(page => {
          if (page) {
            plugin.patchPage(page, sessionId).catch(error => {
              logger.error("Failed to patch page: " +
                `${error instanceof Error ? error.message : String(error)}`);
            });
          }
        })
          .catch(error => {
            logger.error("Failed to patch page: " +
              `${error instanceof Error ? error.message : String(error)}`);
          });
      });
      context.on('targetchanged', (target) => {
        target.page().then(page => {
          if (page) {
            plugin.patchPage(page, sessionId).catch(error => {
              logger.error("Failed to patch page: " +
                `${error instanceof Error ? error.message : String(error)}`);
            });
          }
        })
          .catch(error => {
            logger.error("Failed to patch page: " +
              `${error instanceof Error ? error.message : String(error)}`);
          });
      });

      // Patch pages that are already created
      for (const page of await context.pages()) {
        await plugin.patchPage(page, sessionId);
      }

      return context;
    };
  }

  public async patchPage(page: Page, sessionId: StringUUID) {
    return await observe({ name: 'puppeteer.page' }, async () => {
      await this._patchPage(page, sessionId);
    });
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

    page.on('domcontentloaded', () => {
      injectSessionRecorder(page, this._sessionRecordingOptions).catch(error => {
        logger.error("Error in onLoad handler: " +
          `${error instanceof Error ? error.message : String(error)}`);
      });
    });

    page.on('close', () => {
      sendPageEvents(this._client, page, sessionId, traceId).catch(error => {
        logger.error("Error in onClose handler: " +
          `${error instanceof Error ? error.message : String(error)}`);
      });
    });

    await injectSessionRecorder(page, this._sessionRecordingOptions);

    const chunkBuffers = new Map<string, ChunkBuffer>();

    try {
      await page.exposeFunction(LMNR_SEND_EVENTS_FUNCTION_NAME, async (chunk: EventChunk) => {
        await sendEvents(chunk, this._client, chunkBuffers, sessionId, traceId);
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
