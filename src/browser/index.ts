import { initPuppeteerTracing } from './puppeteer';

export const initBrowserTracing = () => {
  const tryImport = async (pkg: string) => {
    try {
      return await import(pkg);
    } catch {
      return null;
    }
  };

  /**
   * Puppeteer is a work in progress, so we're not using it for now
   * see {@link Laminar.wrapPlaywrightBrowser} for an alternative
   */

  // Promise.all([
  //   tryImport('puppeteer'),
  //   tryImport('puppeteer-core')
  // ]).then(([puppeteer, puppeteerCore]) => {
  //   if (puppeteer || puppeteerCore) {
  //     initPuppeteerTracing();
  //   }
  // });
};
