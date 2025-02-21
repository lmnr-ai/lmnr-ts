import { trace } from '@opentelemetry/api';
import { Laminar } from '../laminar';
import { observe } from '../decorators';
import { newUUID, NIL_UUID, StringUUID } from '../utils';
import { TRACE_HAS_BROWSER_SESSION } from '../sdk/tracing/attributes';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLangVersion, SDK_VERSION } from '../version';

type BrowserNewPageType = (...args: Parameters<any['newPage']>) => ReturnType<any['newPage']>;
type BrowserContextNewPageType = (...args: Parameters<any['newPage']>) => ReturnType<any['newPage']>;
type BrowserNewContextType = (...args: Parameters<any['newContext']>) => ReturnType<any['newContext']>;

// Cross-compatible directory resolution
const getDirname = () => {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  
  if (typeof import.meta?.url !== 'undefined') {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  
  return process.cwd();
};

const injectRrweb = async (page: any) => {
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
    const scriptPath = path.join(getDirname(), '..', 'assets', 'rrweb', 'rrweb.min.js');
    const script = await readFile(scriptPath, 'utf8');
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

      // heartbeat and limit buffer size
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

let _originalWrapBrowserNewPage: BrowserNewPageType | undefined;
let _originalWrapBrowserContextNewPage: BrowserContextNewPageType | undefined;
let _originalWrapBrowserNewContext: BrowserNewContextType | undefined;

const patchedBrowserNewPage = async (...args: Parameters<any['newPage']>) => {
  return observe({
    name: 'browser.new_page',
    ignoreInput: true,
    ignoreOutput: true,
  }, async () => {
    const page = await _originalWrapBrowserNewPage?.call(this, ...args);
    if (!page) throw new Error('Failed to create new page');
    await wrapPlaywrightPage(page);
    return page;
  })
}

const patchedBrowserContextNewPage = async (...args: Parameters<any['newPage']>) => {
  return observe({
    name: 'browser_context.new_page',
    ignoreInput: true,
    ignoreOutput: true,
  }, async () => {
    const page = await _originalWrapBrowserContextNewPage?.call(this, ...args);
    if (!page) throw new Error('Failed to create new page');
    await wrapPlaywrightPage(page);
    return page;
  })
}

const patchedBrowserNewContext = async (...args: Parameters<any['newContext']>) => {
  const context = await _originalWrapBrowserNewContext?.call(this, ...args);
  if (!context) throw new Error('Failed to create new context');
  await wrapPlaywrightContext(context);
  return context;
}

export const wrapPlaywrightBrowser = async (browser: any) => {
  _originalWrapBrowserNewPage = browser.newPage.bind(browser);
  browser.newPage = patchedBrowserNewPage;
  for (const context of browser.contexts()) {
    if (_originalWrapBrowserContextNewPage === undefined) {
      _originalWrapBrowserContextNewPage = context.newPage.bind(context);
    }
    context.newPage = patchedBrowserContextNewPage;
  }
  _originalWrapBrowserNewContext = browser.newContext.bind(browser);
  browser.newContext = patchedBrowserNewContext;
};

export const wrapPlaywrightContext = async (context: any) => {
  _originalWrapBrowserContextNewPage = context.newPage.bind(context);
  context.newPage = patchedBrowserContextNewPage;
};

export const wrapPlaywrightPage = async (page: any) => {
  // NOTE: Do not reorder `addListener` and `injectRrweb`. It only works
  // this way.
  return observe({
    name: 'page',
    ignoreInput: true,
    ignoreOutput: true,
  }, async () => {
    page.addListener("load", (p: any) => {
      injectRrweb(p).catch(error => {
        console.error('Failed to inject rrweb:', error);
      });
    });
    await injectRrweb(page);

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

    page.on('close', () => clearInterval(interval));
  })
};

const collectAndSendPageEvents = async (page: any, sessionId: StringUUID, traceId: StringUUID) => {
  try {
    const hasFunction = await page.evaluate(() => typeof (window as any).lmnrGetAndClearEvents === 'function');
    if (!hasFunction) {
      return;
    }

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
      sdkVersion: SDK_VERSION 
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
      console.error('Failed to send events:', response.statusText);
    }
  } catch (error) {
    console.error('Error sending events:', error);
  }
}