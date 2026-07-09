import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  LaminarAiSdkTelemetry,
} from "../src/opentelemetry-lib/instrumentation/aisdk/v7-integration";
import {
  buildAiSdkInstrumentationAttributes,
  findAiSdkScopeEntries,
  getAiSdkPackageVersions,
  isPackageManagerInternalPath,
} from "../src/opentelemetry-lib/instrumentation/aisdk/v7-integration/package-versions";
import {
  SPAN_INSTRUMENTATION_SCOPE_NAME,
  SPAN_INSTRUMENTATION_SCOPE_VERSION,
} from "../src/opentelemetry-lib/tracing/attributes";

const mkStartEvent = (callId: string) => ({
  callId,
  operationId: "ai.generateText",
  provider: "openai",
  modelId: "gpt-4.1-nano",
  messages: [{ role: "user", content: "hi" }],
});

void describe("AI SDK v7 package version detection", () => {
  void describe("isPackageManagerInternalPath", () => {
    void it("flags pnpm/yarn virtual-store segments", () => {
      assert.equal(
        isPackageManagerInternalPath("/proj/node_modules/.pnpm/node_modules"),
        true,
      );
      assert.equal(
        isPackageManagerInternalPath("/proj/node_modules/.yarn/node_modules"),
        true,
      );
    });

    void it("does not flag plain node_modules paths or relative segments", () => {
      assert.equal(isPackageManagerInternalPath("/proj/node_modules"), false);
      assert.equal(
        isPackageManagerInternalPath("./proj/../proj/node_modules"),
        false,
      );
    });
  });

  void describe("findAiSdkScopeEntries", () => {
    let root: string;

    void beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "aisdk-scope-"));
    });

    void afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    void it(
      "picks the user-installed @ai-sdk scope over a dependency's own " +
        "transitive @ai-sdk scope found earlier in the search path",
      () => {
        // Reproduces the real pnpm shape: `ai`'s own transitive @ai-sdk deps
        // live under a virtual-store path (here simulated with a dotted
        // segment), while the user's directly-installed providers live at
        // the project's top-level node_modules/@ai-sdk.
        const transitiveScope = join(
          root,
          "node_modules",
          ".pnpm",
          "node_modules",
          "@ai-sdk",
        );
        const userScope = join(root, "node_modules", "@ai-sdk");
        mkdirSync(join(transitiveScope, "provider"), { recursive: true });
        mkdirSync(join(userScope, "anthropic"), { recursive: true });
        mkdirSync(join(userScope, "google"), { recursive: true });

        const searchPaths = [
          join(root, "node_modules", ".pnpm", "node_modules"),
          join(root, "node_modules"),
        ];

        const entries = findAiSdkScopeEntries(searchPaths).sort();
        assert.deepEqual(entries, ["anthropic", "google"]);
      },
    );

    void it("skips search-path entries with no @ai-sdk scope", () => {
      mkdirSync(join(root, "node_modules", "@ai-sdk", "otel"), {
        recursive: true,
      });
      const searchPaths = [
        join(root, "node_modules", "some-other-dir"),
        join(root, "node_modules"),
      ];

      assert.deepEqual(findAiSdkScopeEntries(searchPaths), ["otel"]);
    });

    void it("returns an empty list when no search path has an @ai-sdk scope", () => {
      const searchPaths = [join(root, "node_modules")];
      assert.deepEqual(findAiSdkScopeEntries(searchPaths), []);
    });
  });

  void it("reads the installed `ai` package version and discovers @ai-sdk/* siblings", () => {
    const { aiVersion, aiSdkPackages } = getAiSdkPackageVersions();

    assert.equal(typeof aiVersion, "string");
    assert.match(aiVersion as string, /^\d+\.\d+\.\d+/);
    // `ai` depends on `@ai-sdk/provider`, which pnpm places as a sibling
    // under `ai`'s own node_modules scope — a reliable, always-present probe.
    assert.ok(
      Object.keys(aiSdkPackages).some((k) => k.startsWith("@ai-sdk/")),
      "expected at least one @ai-sdk/* package to be discovered",
    );
  });

  void it("builds a flat attributes object with the ai instrumentation scope", () => {
    const attributes = buildAiSdkInstrumentationAttributes();

    assert.equal(attributes[SPAN_INSTRUMENTATION_SCOPE_NAME], "ai");
    assert.equal(typeof attributes[SPAN_INSTRUMENTATION_SCOPE_VERSION], "string");
    assert.ok(
      Object.keys(attributes).some((k) =>
        k.startsWith("lmnr.span.instrumentation.@ai-sdk/"),
      ),
      "expected at least one lmnr.span.instrumentation.@ai-sdk/*.version key",
    );
  });

  void describe("span attributes", () => {
    let exporter: InMemorySpanExporter;

    void beforeEach(() => {
      _resetConfiguration();
      exporter = new InMemorySpanExporter();
      initializeTracing({ exporter, disableBatch: true });
      Object.defineProperty(Laminar, "isInitialized", {
        value: true,
        writable: true,
      });
    });

    void afterEach(async () => {
      await exporter.shutdown();
    });

    void after(() => {
      trace.disable();
      context.disable();
    });

    void it("stamps instrumentation scope attributes on the operation span", () => {
      const tel = new LaminarAiSdkTelemetry();
      tel.onStart(mkStartEvent("call-1"));
      // onStart alone doesn't end the span; onAbort closes it so it exports.
      tel.onAbort({ callId: "call-1" });

      const opSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === "ai.generateText");
      assert.ok(opSpan, "operation span missing");
      assert.equal(opSpan.attributes[SPAN_INSTRUMENTATION_SCOPE_NAME], "ai");
      assert.equal(
        typeof opSpan.attributes[SPAN_INSTRUMENTATION_SCOPE_VERSION],
        "string",
      );
      assert.ok(
        Object.keys(opSpan.attributes).some((k) =>
          k.startsWith("lmnr.span.instrumentation.@ai-sdk/"),
        ),
      );
    });
  });
});
