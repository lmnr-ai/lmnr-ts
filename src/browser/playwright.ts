import { trace } from '@opentelemetry/api';
import { Laminar } from '../laminar';
import { newUUID } from '../utils';
import { TRACE_HAS_BROWSER_SESSION } from '../sdk/tracing/attributes';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Page } from 'playwright';

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

const injectRrweb = async (page: Page) => {
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

  const isRrwebPresent = await page.evaluate(() => {
    return typeof (window as any).lmnrRrweb !== 'undefined';
  });

  // Get current trace ID from active span
  const currentSpan = trace.getActiveSpan();
  const traceId = (currentSpan?.spanContext().traceId || '').padStart(32, '0');
  currentSpan?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
  if (!Laminar.initialized()) {
    throw new Error('Laminar is not initialized. Make sure to call Laminar.initalize() before using browser wrappers.');
  }

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

  const httpUrl = Laminar.getHttpUrl();
  const projectApiKey = Laminar.getProjectApiKey();
  const sessionId = newUUID();

  // Generate UUID session ID and set trace ID
  await tryRunScript(async () => {
    await page.evaluate((args: string[]) => {
      const traceId = args[0];
      const sessionId = args[1];
      (window as any).lmnrRrwebSessionId = sessionId;
      (window as any).lmnrTraceId = traceId;
    }, [traceId, sessionId]);
  });

  // Update the recording setup to include trace ID
  await tryRunScript(async () => {
    await page.evaluate((args: string[]) => {
      const baseUrl = args[0];
      const projectApiKey = args[1];
      const serverUrl = `${baseUrl}/v1/browser-sessions/events`;
      const FLUSH_INTERVAL = 1000;
      const HEARTBEAT_INTERVAL = 1000;  // 1 second heartbeat

      (window as any).lmnrRrwebEventsBatch = [];
      
      (window as any).lmnrSendRrwebEventsBatch = async () => {
        if ((window as any).lmnrRrwebEventsBatch.length === 0) return;
                
        const eventsPayload = {
          sessionId: (window as any).lmnrRrwebSessionId,
          traceId: (window as any).lmnrTraceId,
          events: (window as any).lmnrRrwebEventsBatch,
        };

        try {
          const jsonString = JSON.stringify(eventsPayload);
          const uint8Array = new TextEncoder().encode(jsonString);

          const cs = new CompressionStream('gzip');
          const compressedStream = await new Response(
            new Response(uint8Array).body?.pipeThrough(cs)
          ).arrayBuffer();

          const compressedArray = new Uint8Array(compressedStream);
          const blob = new Blob([compressedArray], { type: 'application/octet-stream' });

          const response = await fetch(serverUrl, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              'Authorization': `Bearer ${projectApiKey}`,
              'Accept': 'application/json',
            },
            body: blob,
            credentials: 'omit',
            mode: 'cors',
          });

          if (!response.ok) {
            console.error(`HTTP error! status: ${response.status}`);
            if (response.status === 0) {
                console.error('Possible CORS issue - check network tab for details');
            }
          }
          (window as any).lmnrRrwebEventsBatch = [];
        } catch (error) {
          console.error('Failed to send events:', error);
        }
      };

      setInterval(() => (window as any).lmnrSendRrwebEventsBatch(), FLUSH_INTERVAL);

      // Add heartbeat event
      setInterval(() => {
        (window as any).lmnrRrwebEventsBatch.push({
          type: 6, // Custom event type
          data: { source: 'heartbeat' },
          timestamp: Date.now()
        });
      }, HEARTBEAT_INTERVAL);

      (window as any).lmnrRrweb.record({
        emit(event: any) {
          (window as any).lmnrRrwebEventsBatch.push(event);
        }
      });

      window.addEventListener('beforeunload', async () => {
        await (window as any).lmnrSendRrwebEventsBatch();
      });
    }, [httpUrl, projectApiKey]);
  });

};

const handleRoute = async (route: any) => {
  if (!Laminar.initialized()) {
    throw new Error('Laminar is not initialized. Make sure to call Laminar.initalize() before using browser wrappers.');
  }

  const httpUrl = Laminar.getHttpUrl();
  try {
    const response = await route.fetch();
    const headers = response.headers();
    const newHeaders: {[key: string]: string} = {};

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() == "content-security-policy") {
        const csp = value as string;
        const cspParts = csp.split(";");
        const modifiedParts = cspParts.map(part => {
          if (part.includes('connect-src')) {
            return `${part.trim()} ${httpUrl}`;
          }
          return part;
        });
        const modifiedCsp = modifiedParts.join(';');
        newHeaders['Content-Security-Policy'] = modifiedCsp;
      } else {
        newHeaders[key] = value as string;
      }
    }
    await route.fulfill({
      response,
      headers: newHeaders,
    })
  } catch (error) {
    await route.continue();
  }
}

let _originalWrapBrowserNewPage: BrowserNewPageType | undefined;
let _originalWrapBrowserContextNewPage: BrowserContextNewPageType | undefined;
let _originalWrapBrowserNewContext: BrowserNewContextType | undefined;

const patchedBrowserNewPage = async (...args: Parameters<any['newPage']>) => {
  const page = await _originalWrapBrowserNewPage?.call(this, ...args);
  if (!page) throw new Error('Failed to create new page');
  await wrapPlaywrightPage(page);
  return page;
}

const patchedBrowserContextNewPage = async (...args: Parameters<any['newPage']>) => {
  const page = await _originalWrapBrowserContextNewPage?.call(this, ...args);
  if (!page) throw new Error('Failed to create new page');
  await wrapPlaywrightPage(page);
  return page;
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
    context.route('**/*', handleRoute);
    context.newPage = patchedBrowserContextNewPage;
  }
  _originalWrapBrowserNewContext = browser.newContext.bind(browser);
  browser.newContext = patchedBrowserNewContext;
};

export const wrapPlaywrightContext = async (context: any) => {
  context.route('**/*', handleRoute);
  _originalWrapBrowserContextNewPage = context.newPage.bind(context);
  context.newPage = patchedBrowserContextNewPage;
};

export const wrapPlaywrightPage = async (page: any) => {
  // NOTE: Do not reorder `addListener` and `injectRrweb`. It only works
  // this way.
  page.addListener("load", (p: any) => {
    injectRrweb(p).catch(error => {
      console.error('Failed to inject rrweb:', error);
    });
  });
  await injectRrweb(page);
};
