import assert from "node:assert";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { chromium } from "@playwright/test";

import { _resetConfiguration, initializeTracing } from "../src/sdk/configuration";
import { NIL_UUID, otelTraceIdToUUID } from "../src/utils";

// This test fails to inject rrweb and send events,
// but for now it only tests tracing, so it's fine.

void describe("playwright", () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  void beforeEach(() => {
    // This only uses underlying OpenLLMetry initialization, not Laminar's
    // initialization, but this is sufficient for testing.
    // Laminar.initialize() is tested in the other suite.
    _resetConfiguration();
    initializeTracing({
      processor,
      exporter,
      instrumentModules: {
        playwright: {
          chromium: chromium,
        },
      },
    });
  });


  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await processor.shutdown();
    trace.disable();
    context.disable();
  });

  // TODO: figure out if this can run in Github Actions
  void it("exports all spans to a single trace", async () => {
    const browser = await chromium.launch({
      headless: true,
    });
    const page = await browser.newPage();

    // Navigate the page to a URL.
    await page.goto('https://developer.chrome.com/');

    // Type into search box.
    await page.locator('.devsite-search-field').fill('automate beyond recorder');

    await page.locator('.devsite-search-field').press('Enter');

    // Locate the full title with a unique string.
    const textSelector = page
      .locator('.gs-title', { hasText: 'Customize and automate user ' })
      .first();

    await textSelector?.waitFor();
    await textSelector?.click();

    await browser.close();

    const spans = exporter.getFinishedSpans();
    const traceId = spans[0].spanContext().traceId;

    assert.notStrictEqual(
      otelTraceIdToUUID(traceId),
      NIL_UUID,
    );

    assert.strictEqual(
      true,
      spans.every((span) => span.spanContext().traceId === traceId),
    );
  });
});
