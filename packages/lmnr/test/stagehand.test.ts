import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
} from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { StagehandInstrumentation } from "../src/browser/stagehand/v3";
import { Laminar } from "../src/index";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unused-vars
*/

// These tests exercise the wrap/unwrap guards and the BROWSERBASE apiClient
// fallback path. We do not pull in the real @browserbasehq/stagehand package
// here; we construct Stagehand-shaped stubs and let the instrumentation
// `manuallyInstrument` + `patchStagehandInit` against them.

const collectDiagWarnings = (): { restore: () => void; warnings: string[] } => {
  const warnings: string[] = [];
  diag.setLogger({
    verbose: () => { /* noop */ },
    debug: () => { /* noop */ },
    info: () => { /* noop */ },
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    error: () => { /* noop */ },
  }, DiagLogLevel.ALL);
  return {
    warnings,
    restore: () => {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.NONE);
    },
  };
};

void describe("Stagehand v3 instrumentation — wrap guards", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it(
    "does not warn when wrapping a Stagehand instance with missing handlers",
    async () => {
      const { warnings, restore } = collectDiagWarnings();
      try {
        // Minimal Stagehand stub with no handlers / llmClient / apiClient.
        class StubStagehand {
          async init() { return; }
          async close() { return; }
          async act(_arg?: unknown) { return; }
          async extract(_arg?: unknown) { return; }
          async observe(_arg?: unknown) { return; }
        }

        const instrumentation = new StagehandInstrumentation();
        instrumentation.manuallyInstrument(StubStagehand);

        const instance = new StubStagehand();
        await instance.init();

        // No "Cannot wrap non-existent method" warnings should have been emitted.
        const nonExistentWarnings = warnings.filter(
          (w) => /non[- ]existent method|not found|cannot wrap/i.test(w),
        );
        assert.deepEqual(
          nonExistentWarnings,
          [],
          `Got unexpected warnings: ${warnings.join(" | ")}`,
        );

        await instance.close();
      } finally {
        restore();
      }
    },
  );

  void it(
    "wraps apiClient methods when present (BROWSERBASE remote mode)",
    async () => {
      const { restore } = collectDiagWarnings();
      try {
        const calls: string[] = [];

        class StubApiClient {
          async act() {
            calls.push("apiClient.act");
            return { success: true };
          }
          async extract() {
            calls.push("apiClient.extract");
            return { extraction: "ok" };
          }
          async observe() {
            calls.push("apiClient.observe");
            return [];
          }
          async agentExecute() {
            calls.push("apiClient.agentExecute");
            return {
              completed: true,
              success: true,
              message: "done",
              usage: { input_tokens: 10, output_tokens: 20 },
            };
          }
        }

        class StubStagehand {
          apiClient: StubApiClient | null = null;
          async init() {
            // Simulate Stagehand v3 in BROWSERBASE remote mode: an
            // apiClient is created at init time and local handlers /
            // llmClient are never invoked.
            this.apiClient = new StubApiClient();
          }
          async close() { return; }
          async act() { return this.apiClient!.act(); }
          async extract() { return this.apiClient!.extract(); }
          async observe() { return this.apiClient!.observe(); }
        }

        const instrumentation = new StagehandInstrumentation();
        instrumentation.manuallyInstrument(StubStagehand);

        const instance = new StubStagehand();
        await instance.init();

        // apiClient methods should have been wrapped in-place.
        const api = instance.apiClient! as unknown as Record<string, any>;
        assert.ok(api.act.__original, "apiClient.act should be wrapped");
        assert.ok(api.extract.__original, "apiClient.extract should be wrapped");
        assert.ok(api.observe.__original, "apiClient.observe should be wrapped");
        assert.ok(
          api.agentExecute.__original,
          "apiClient.agentExecute should be wrapped",
        );

        // Exercise one call and confirm a stagehand.apiClient.act span is
        // emitted (this is the span that BROWSERBASE remote mode used to miss).
        await instance.act();

        const spans = exporter.getFinishedSpans();
        const names = spans.map((s) => s.name);
        assert.ok(
          names.includes("stagehand.apiClient.act"),
          `Expected stagehand.apiClient.act span, got: ${names.join(", ")}`,
        );

        await instance.close();
      } finally {
        restore();
      }
    },
  );
});

/* eslint-enable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unused-vars
*/
