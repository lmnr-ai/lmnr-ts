// @ts-ignore
import { Page, BrowserContext, Browser, Response } from 'playwright';

import { trace } from '@opentelemetry/api';
import { Laminar } from '../laminar';
import { newUUID } from '../utils';
import { TRACE_HAS_BROWSER_SESSION } from '../sdk/tracing/attributes';

type PageGotoType = (...args: Parameters<Page['goto']>) => Promise<null|Response>;
type BrowserNewPageType = (...args: Parameters<Browser['newPage']>) => Promise<Page>;
type BrowserContextNewPageType = (...args: Parameters<BrowserContext['newPage']>) => Promise<Page>;
type BrowserNewContextType = (...args: Parameters<Browser['newContext']>) => Promise<BrowserContext>;

const injectRrweb = async (page: Page) => {
  // Wait for the page to be in a ready state first
  await page.waitForLoadState('domcontentloaded');

  // Get current trace ID from active span
  const currentSpan = trace.getActiveSpan();
  const traceId = (currentSpan?.spanContext().traceId || '').padStart(32, '0');
  currentSpan?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
  if (!Laminar.initialized()) {
    throw new Error('Laminar is not initialized. Make sure to call Laminar.initalize() before using browser wrappers.');
  }

  const httpUrl = Laminar.getHttpUrl();
  const projectApiKey = Laminar.getProjectApiKey();
  const sessionId = newUUID();

  // Wait for any existing script load to complete
  await page.waitForLoadState('networkidle');

  // Generate UUID session ID and set trace ID
  await page.evaluate((args: string[]) => {
    const traceId = args[0];
    const sessionId = args[1];
    (window as any).rrwebSessionId = sessionId;
    (window as any).traceId = traceId;
  }, [traceId, sessionId]);

  // Load rrweb and set up recording
  await page.addScriptTag({
    url: "https://cdn.jsdelivr.net/npm/rrweb@latest/dist/rrweb.min.js",
  });

  await page.waitForFunction(() => (window as any).rrweb || 'rrweb' in window);

  // Update the recording setup to include trace ID
  await page.evaluate((args: string[]) => {
    const baseUrl = args[0];
    const projectApiKey = args[1];
    const serverUrl = `${baseUrl}/v1/browser-sessions/events`;
    const BATCH_SIZE = 50;
    const FLUSH_INTERVAL = 2000;
    const HEARTBEAT_INTERVAL = 1000;  // 1 second heartbeat

    (window as any).rrwebEventsBatch = [];
    
    (window as any).sendBatch = async (isEnd = false) => {
      if ((window as any).rrwebEventsBatch.length === 0) return;
              
      const eventsPayload = {
        sessionId: (window as any).rrwebSessionId,
        traceId: (window as any).traceId,
        events: (window as any).rrwebEventsBatch,
        isEndOfSession: isEnd
      };

      try {
        await fetch(serverUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${projectApiKey}` 
          },
          body: JSON.stringify(eventsPayload),
        });
        (window as any).rrwebEventsBatch = [];
      } catch (error) {
        console.error('Failed to send events:', error);
      }
    };

    setInterval(() => (window as any).sendBatch(false), FLUSH_INTERVAL);

    // Add heartbeat event
    setInterval(() => {
      (window as any).rrwebEventsBatch.push({
        type: 6, // Custom event type
        data: { source: 'heartbeat' },
        timestamp: Date.now()
      });
    }, HEARTBEAT_INTERVAL);

    (window as any).rrweb.record({
      emit(event: any) {
        (window as any).rrwebEventsBatch.push(event);
                  
          if ((window as any).rrwebEventsBatch.length >= BATCH_SIZE) {
            (window as any).sendBatch(false);
          }
        }
      });

      window.addEventListener('beforeunload', () => {
        (window as any).sendBatch(true);
      });
  }, [httpUrl, projectApiKey]);

  (page as any).__gotoPatchedLmnr = true;
};

let _originalWrapBrowserNewPage: BrowserNewPageType | undefined;
let _originalWrapBrowserContextNewPage: BrowserContextNewPageType | undefined;
let _originalWrapBrowserNewContext: BrowserNewContextType | undefined;
let _originalPageGoto: PageGotoType | undefined;

const patchedBrowserNewPage = async (...args: Parameters<Browser['newPage']>) => {
  const page = await _originalWrapBrowserNewPage?.call(this, ...args);
  if (!page) throw new Error('Failed to create new page');
  await wrapPlaywrightPage(page);
  return page;
}

const patchedBrowserContextNewPage = async (...args: Parameters<BrowserContext['newPage']>) => {
  const page = await _originalWrapBrowserContextNewPage?.call(this, ...args);
  if (!page) throw new Error('Failed to create new page');
  await wrapPlaywrightPage(page);
  return page;
}

const patchedBrowserNewContext = async (...args: Parameters<Browser['newContext']>) => {
  const context = await _originalWrapBrowserNewContext?.call(this, ...args);
  if (!context) throw new Error('Failed to create new context');
  await wrapPlaywrightContext(context);
  return context;
}

export const wrapPlaywrightBrowser = async (browser: Browser) => {
  if (_originalWrapBrowserNewPage === undefined) {
    _originalWrapBrowserNewPage = browser.newPage.bind(browser);
    browser.newPage = patchedBrowserNewPage;
    for (const context of browser.contexts()) {
      if (_originalWrapBrowserContextNewPage === undefined) {
        _originalWrapBrowserContextNewPage = context.newPage.bind(context);
      }
      context.newPage = patchedBrowserContextNewPage;
    }
    if (_originalWrapBrowserNewContext === undefined) {
      _originalWrapBrowserNewContext = browser.newContext.bind(browser);
      browser.newContext = patchedBrowserNewContext;
    }
  }
};

export const wrapPlaywrightContext = async (context: BrowserContext) => {
  if (_originalWrapBrowserContextNewPage === undefined) {
    _originalWrapBrowserContextNewPage = context.newPage.bind(context);
    context.newPage = patchedBrowserContextNewPage;
  }
};

export const wrapPlaywrightPage = async (page: Page) => {
  await injectRrweb(page);
  if (_originalPageGoto === undefined) {
    _originalPageGoto = page.goto.bind(page);
    page.goto = async function (...args: Parameters<Page['goto']>) {
      const result = await _originalPageGoto?.call(page, ...args);
      await injectRrweb(page);
      return result ?? null;
    };
  }
};
