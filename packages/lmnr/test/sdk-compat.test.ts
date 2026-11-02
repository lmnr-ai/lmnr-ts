import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSdkAdapter,
  getSdkAdapter,
} from "../src/opentelemetry-lib/tracing/sdk-compat";

const exporter = {
  export: (_spans: unknown, done: (result: { code: number }) => void) =>
    done({ code: 0 }),
  shutdown: async () => undefined,
} as any;

// Records the arguments each fake SDK constructor received.
const fakeModule = (providerName: "TracerProvider" | "BasicTracerProvider") => {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) =>
    class {
      constructor(...args: unknown[]) {
        calls[name] = args;
      }
    };
  return {
    calls,
    mod: {
      SimpleSpanProcessor: record("simple"),
      BatchSpanProcessor: record("batch"),
      AlwaysOnSampler: record("sampler"),
      [providerName]: record("provider"),
    },
  };
};

void describe("buildSdkAdapter", () => {
  void it("constructs processors positionally for sdk-trace-base (v1 / v2)", () => {
    const { mod, calls } = fakeModule("BasicTracerProvider");
    const sdk = buildSdkAdapter(mod, false);

    sdk.createSimpleSpanProcessor(exporter);
    assert.deepEqual(calls.simple, [exporter]);

    sdk.createBatchSpanProcessor(exporter, { maxExportBatchSize: 7 });
    assert.deepEqual(calls.batch, [exporter, { maxExportBatchSize: 7 }]);
  });

  void it("constructs processors with an options object for sdk-trace (2.12+ / v3)", () => {
    const { mod, calls } = fakeModule("TracerProvider");
    const sdk = buildSdkAdapter(mod, true);

    sdk.createSimpleSpanProcessor(exporter);
    assert.deepEqual(calls.simple, [{ exporter }]);

    sdk.createBatchSpanProcessor(exporter, { maxExportBatchSize: 7 });
    assert.deepEqual(calls.batch, [{ exporter, maxExportBatchSize: 7 }]);

    // No config is fine too.
    sdk.createBatchSpanProcessor(exporter);
    assert.deepEqual(calls.batch, [{ exporter }]);
  });

  void it("uses whichever provider class the SDK exports", () => {
    for (const name of ["TracerProvider", "BasicTracerProvider"] as const) {
      const { mod, calls } = fakeModule(name);
      const config = {
        spanProcessors: [],
        sampler: buildSdkAdapter(mod, true).createAlwaysOnSampler(),
        resource: {},
      };
      buildSdkAdapter(mod, true).createTracerProvider(config);
      assert.deepEqual(calls.provider, [config]);
    }
  });
});

void describe("getSdkAdapter", () => {
  void it("resolves an installed SDK and builds working processors", () => {
    const sdk = getSdkAdapter();
    const processor = sdk.createSimpleSpanProcessor(exporter);
    assert.equal(typeof processor.onEnd, "function");
    assert.equal(typeof sdk.createAlwaysOnSampler().shouldSample, "function");
  });
});
