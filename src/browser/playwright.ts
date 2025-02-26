import { Span, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import path from "path";
import { readFile } from "fs/promises";

import { newUUID, NIL_UUID, StringUUID } from '../utils';
import { observe as laminarObserve } from '../decorators';
import type * as PlaywrightLib from "playwright";
import type { Page, Browser, BrowserContext } from 'playwright';
import type { Page as StagehandPage } from '@browserbasehq/stagehand';

import { version as SDK_VERSION } from "../../package.json";
import { TRACE_HAS_BROWSER_SESSION } from '../sdk/tracing/attributes';
import { collectAndSendPageEvents } from "./utils";
import { getDirname } from "./utils";
import { Laminar } from '../laminar';

const RRWEB_SCRIPT_PATH = path.join(
  getDirname(),
  '..',
  'assets',
  'rrweb', 'rrweb.min.js',
);

export class PlaywrightInstrumentation extends InstrumentationBase {
  private _patchedBrowsers: Set<Browser> = new Set();
  private _patchedContexts: Set<BrowserContext> = new Set();
  private _patchedPages: Set<Page> = new Set();
  public parentSpan: Span | undefined;

  constructor() {
    super(
      "@lmnr/playwright-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      }
    )
    this.parentSpan = undefined;
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
          this.patchBrowserLaunch()
        );

        this._wrap(
          browserType,
          'connect',
          this.patchBrowserConnect()
        );

        this._wrap(
          browserType,
          'connectOverCDP',
          this.patchBrowserConnect()
        );

        this._wrap(
          browserType,
          'launchPersistentContext',
          this.patchBrowserNewContext()
        );
      }
    }
    
    return pwModule;  
  }

  private patch(moduleExports: typeof PlaywrightLib, moduleVersion?: string) {
    const browsers = ['chromium', 'firefox', 'webkit'] as const;
    
    for (const browserType of browsers) {
      if (moduleExports[browserType]) {
        // First we need to patch the browser launch to get access to the Page class
        this._wrap(
          moduleExports[browserType],
          `launch`,
          this.patchBrowserLaunch()
        );

        this._wrap(
          moduleExports[browserType],
          `connect`,
          this.patchBrowserConnect()
        );

        this._wrap(
          moduleExports[browserType],
          'connectOverCDP',
          this.patchBrowserConnect()
          );

        this._wrap(
          moduleExports[browserType],
          'launchPersistentContext',
          this.patchBrowserNewContext()
        );
      }
    }
    
    return moduleExports;   
  }

  private unpatch(moduleExports: typeof PlaywrightLib, moduleVersion?: string) {
    const browsers = ['chromium', 'firefox', 'webkit'] as const;
    
    for (const browserType of browsers) {
      if (moduleExports[browserType]) {
        // First we need to patch the browser launch to get access to the Page class
        this._wrap(
          moduleExports[browserType],
          `launch`,
          this.patchBrowserLaunch()
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

  private patchBrowserConnect() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: Browser, ...args: unknown[]) {
        const browser = await original.call(this, ...args);
        plugin.parentSpan = Laminar.startSpan({
          name: 'playwright',
        });

        plugin._wrap(
          browser,
          'newContext',
          plugin.patchBrowserNewContext()
        )

        plugin._wrap(
          browser,
          'newPage',
          plugin.patchBrowserNewPage()
        )

        plugin._wrap(
          browser,
          'close',
          plugin.patchBrowserClose()
        )

        plugin._patchedBrowsers.add(browser);
        return browser;
      }
    }
  }

  private patchBrowserLaunch() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: Browser, ...args: any[]) {
        const browser = await original.call(this, ...args);
        plugin.parentSpan = Laminar.startSpan({
          name: 'playwright',
        });


        plugin._wrap(
          browser,
          'newContext',
          plugin.patchBrowserNewContext(),
        )

        plugin._wrap(
          browser,
          'newPage',
          plugin.patchBrowserNewPage(),
        )

        plugin._wrap(
          browser,
          'close',
          plugin.patchBrowserClose()
        )

        plugin._patchedBrowsers.add(browser);
        return browser;
      }
    }
  }

  private patchBrowserClose() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: Browser, ...args: unknown[]) {
        await original.call(this, ...args);
        plugin.parentSpan?.end();
      }
    }
  }

  private patchBrowserNewContext() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: Browser, ...args: unknown[]) {
        const context = await original.bind(this).apply(this, args);
        if (!plugin.parentSpan) {
          plugin.parentSpan = Laminar.startSpan({
            name: 'playwright',
          });
        }
        plugin._wrap(
          context,
          'newPage',
          plugin.patchBrowserContextNewPage(),
        );
        plugin._wrap(
          context,
          'close',
          plugin.patchBrowserContextClose()
        );
        for (const page of context.pages()) {
          plugin.patchPage(page);
        }
        plugin._patchedContexts.add(context);
        return context;
      }
    }
  }

  private patchBrowserContextClose() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: BrowserContext, ...args: unknown[]) {
        await original.bind(this).apply(this, args);
        if (plugin.parentSpan && plugin.parentSpan.isRecording()) {
          plugin.parentSpan.end();
        }
      }
    }
  }

  private patchBrowserNewPage() {
    const plugin = this;
    return (original: Function) => {

      return async function method(this: Browser, ...args: unknown[]) {
        const page = await original.bind(this).apply(this, args);
        if (!page) {
          return null;
        }
        // TODO: investigate why this creates a separate empty span and no events
        // await plugin.patchPage(page);
        return page;
      }
    }
  }
 
  public patchBrowserContextNewPage() {
    const plugin = this;
    return (original: Function) => {
      return async function method(this: BrowserContext, ...args: unknown[]) {
        const page = await original.bind(this).apply(this, args);
        if (!plugin.parentSpan) {
          plugin.parentSpan = Laminar.startSpan({
            name: 'playwright',
          });
        }
        if (!page) {
          return null;
        }
        
        await plugin.patchPage(page);

        return page;
      }
    }
  }

  public async patchPage(page: Page & StagehandPage) {
    return await Laminar.withSpan(this.parentSpan!, async () => {
      await laminarObserve(
        {
          name: `playwright.page`,
          ignoreInput: true,
          ignoreOutput: true,
        },
        async (p) => {
          Laminar.setSpanAttributes({
            "act_in_page": 'act' in p
          })
          return await this._patchPage(p);
        },
        page,
      )
    });
  }

  private async _patchPage(page: Page & StagehandPage) {
    this._patchedPages.add(page);

    await this.injectRrweb(page);

    page.addListener("load", (p: Page) => {
      this.injectRrweb(p).catch(error => {
        console.error('Failed to inject rrweb:', error);
      });
    });

    trace.getActiveSpan()?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);

    const traceId = trace.getActiveSpan()?.spanContext().traceId as StringUUID ?? NIL_UUID;
    const sessionId = newUUID();
    const interval = setInterval(async () => {
      if (page.isClosed()) {
        return;
      }
      try {
        await collectAndSendPageEvents(page, sessionId, traceId);
      } catch (error) {
        console.error('Event collection stopped:', error);
      }
    }, 2000);

    page.addListener('close', () => clearInterval(interval));
  }

  private async injectRrweb(page: Page | StagehandPage) {
    // Wait for the page to be in a ready state first
    await page.waitForLoadState('domcontentloaded');
    const tryRunScript = async(script: (...args: any[]) => Promise<any>, maxAttempts: number = 5) => {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await script();
        } catch (error) {
          console.error("Operation failed: ", error);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };
  
    const isRrwebPresent = await page.evaluate(() =>
      typeof (window as any).lmnrRrweb !== 'undefined'
    );
  
    // Load rrweb and set up recording
    if (!isRrwebPresent) {
      const script = await readFile(RRWEB_SCRIPT_PATH, 'utf8');
      await tryRunScript(async () => {
        await page.addScriptTag({
          content: script,
        });
        const res= await page.waitForFunction(() => 'lmnrRrweb' in window || (window as any).lmnrRrweb, {
          timeout: 5000,
        });
        if (!res) {
          throw new Error('Failed to inject rrweb');
        }
      });
    }
  
    // Update the recording setup to include trace ID
    await tryRunScript(async () => {
      await page.evaluate(() => {
        const BATCH_SIZE = 1000; // Maximum events to store in memory
        const HEARTBEAT_INTERVAL = 1000;  // 1 second heartbeat
  
        (window as any).lmnrRrwebEventsBatch = [];
        
        const compressEventData = async (data: any) => {
          const jsonString = JSON.stringify(data);
          const blob = new Blob([jsonString], { type: 'application/json' });
          const compressedStream = blob.stream().pipeThrough(new CompressionStream('gzip'));
          const compressedResponse = new Response(compressedStream);
          const compressedData = await compressedResponse.arrayBuffer();
          return Array.from(new Uint8Array(compressedData));
        }
  
        (window as any).lmnrGetAndClearEvents = () => {
          const events = (window as any).lmnrRrwebEventsBatch;
          (window as any).lmnrRrwebEventsBatch = [];
          return events;
        }
  
        setInterval(async () => {
          const heartbeatEvent = {
            type: 6, // Custom event type
            data: await compressEventData({ source: 'heartbeat' }),
            timestamp: Date.now()
          };
  
          (window as any).lmnrRrwebEventsBatch?.push(heartbeatEvent);
  
          if ((window as any).lmnrRrwebEventsBatch?.length > BATCH_SIZE) {
            // Drop oldest events to prevent memory issues
            (window as any).lmnrRrwebEventsBatch = (window as any).lmnrRrwebEventsBatch.slice(-BATCH_SIZE);
          }
        }, HEARTBEAT_INTERVAL);
  
        (window as any).lmnrRrweb.record({
          async emit(event: any) {
            const compressedEvent = {
              ...event,
              data: await compressEventData(event.data)
            };
            (window as any).lmnrRrwebEventsBatch.push(compressedEvent);
          }
        });
      });
    });
  
  };
}
