// these imports are only needed to for types. This module must
// not be imported unless puppeteer is available.
// @ts-ignore
import { Browser as BrowserCore, Page as PageCore } from 'puppeteer-core';
// @ts-ignore
import { Browser, Page } from 'puppeteer';

import { trace } from '@opentelemetry/api';
import { Laminar } from '../laminar';
import { newUUID } from '../utils';
import { TRACE_HAS_BROWSER_SESSION } from '../sdk/tracing/attributes';

let _originalNewPage: typeof Browser.prototype.newPage | null = null;
let _originalNewPageCore: typeof BrowserCore.prototype.newPage | null = null;
let _originalGoto: typeof Page.prototype.goto | null = null;
let _originalGotoCore: typeof PageCore.prototype.goto | null = null;

export const initPuppeteerTracing = () => {
  const injectRrweb = async (page: any) => {
    // Wait for the page to be in a ready state first
    await page.waitForLoadState('domcontentloaded');

    // Get current trace ID from active span
    const currentSpan = trace.getActiveSpan();
    currentSpan?.setAttribute(TRACE_HAS_BROWSER_SESSION, true);
    const traceId = (currentSpan?.spanContext().traceId || '').padStart(32, '0');

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
      url: "https://cdn.jsdelivr.net/npm/rrweb@latest/dist/rrweb.min.js"
    });

    await page.waitForFunction(() => (window as any).rrweb || 'rrweb' in window);

    // Update the recording setup to include trace ID
    await page.evaluate((args: string[]) => {
      const baseUrl = args[0];
      const projectApiKey = args[1];
      const serverUrl = `${baseUrl}/v1/browser-sessions/events`;
      const BATCH_SIZE = 50;
      const FLUSH_INTERVAL = 2000;
      const HEARTBEAT_INTERVAL = 1000; // 1 second heartbeat

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
  };

  const patchedNewPage = async function(this: Browser, ...args: Parameters<typeof Browser.prototype.newPage>) {
    // Call the original newPage
    const page = await _originalNewPage?.call(this, ...args);
    if (!page) throw new Error('Failed to create new page');
        
    // Inject rrweb automatically after the page is created
    await injectRrweb(page);
    return page;
  };

  const patchedGoto = async function(this: Page, ...args: Parameters<typeof Page.prototype.goto>) {
    // Call the original goto
    const result = await _originalGoto?.call(this, ...args);
    // Inject rrweb after navigation
    await injectRrweb(this);
    return result ?? null;
  };

  const patchedNewPageCore = async function(this: BrowserCore, ...args: Parameters<typeof BrowserCore.prototype.newPage>) {
    // Call the original newPage
    const page = await _originalNewPageCore?.call(this, ...args);
    if (!page) throw new Error('Failed to create new page');
    
    // Inject rrweb automatically after the page is created
    await injectRrweb(page);
    return page;
  };

  const patchedGotoCore = async function(this: PageCore, ...args: Parameters<typeof PageCore.prototype.goto>) {
    // Call the original goto
    const result = await _originalGotoCore?.call(this, ...args);
    // Inject rrweb after navigation
    await injectRrweb(this);
    return result ?? null;
  };

  const patchBrowser = () => {
    if (!_originalNewPage || !_originalGoto) {
      // Try dinamically importing puppeteer, otherwise silently continue
      try {
        const { Browser, Page } = require('puppeteer');
        _originalNewPage = Browser.prototype.newPage;
        Browser.prototype.newPage = patchedNewPage;

        _originalGoto = Page.prototype.goto;
        Page.prototype.goto = patchedGoto;
      } catch (error) {}
    }

    if (!_originalNewPageCore || !_originalGotoCore) {
      // Try dinamically importing puppeteer, otherwise silently continue
      try {
        const { Browser: BrowserCore, Page: PageCore } = require('puppeteer-core');
        _originalNewPageCore = BrowserCore.prototype.newPage;
        BrowserCore.prototype.newPage = patchedNewPageCore;

        _originalGotoCore = PageCore.prototype.goto;
        PageCore.prototype.goto = patchedGotoCore;
      } catch (error) {}
    }
  };

  patchBrowser();
};
