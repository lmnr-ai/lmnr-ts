// Compatibility with the OTel trace SDK lines a host app may have installed.
//
// - `@opentelemetry/sdk-trace-base` 1.x / 2.x: processors are constructed
//   positionally, `new BatchSpanProcessor(exporter, config)`, and the provider
//   is `BasicTracerProvider`.
// - `@opentelemetry/sdk-trace` 2.12+ / 3.x: processors take an options object,
//   `new BatchSpanProcessor({ exporter, ...config })`, and the provider is
//   `TracerProvider`. (`sdk-trace-base` 2.12 is a deprecated shim over it that
//   keeps the positional signatures, which is why the constructor style is
//   decided by the package that resolved, not by a version number.)
//
// Everything that constructs an SDK class goes through the factories below, so
// the rest of the SDK does not care which line is installed.
import type { TracerProvider } from "@opentelemetry/api";
import type {
  BufferConfig,
  Sampler,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { initializeLogger } from "../../utils";

const logger = initializeLogger();

export type SdkModule = Record<string, any>;

export interface TracerProviderConfig {
  spanProcessors: SpanProcessor[];
  sampler: Sampler;
  // `Resource` (v1) or `IResource` / `Resource` (v2, v3): structurally typed
  // differently across lines, so it stays opaque here.
  resource: unknown;
}

export interface SdkAdapter {
  createSimpleSpanProcessor: (exporter: SpanExporter) => SpanProcessor;
  createBatchSpanProcessor: (
    exporter: SpanExporter,
    config?: BufferConfig,
  ) => SpanProcessor;
  createTracerProvider: (config: TracerProviderConfig) => TracerProvider;
  createAlwaysOnSampler: () => Sampler;
}

/**
 * Builds the adapter over an already-resolved SDK module. Exported for tests,
 * which pass fake modules for each line.
 *
 * @param mod The module, `sdk-trace` or `sdk-trace-base`.
 * @param optionsStyle Whether processors take `{ exporter, ...config }`.
 */
export const buildSdkAdapter = (
  mod: SdkModule,
  optionsStyle: boolean,
): SdkAdapter => ({
  createSimpleSpanProcessor: (exporter) =>
    optionsStyle
      ? new mod.SimpleSpanProcessor({ exporter })
      : new mod.SimpleSpanProcessor(exporter),
  createBatchSpanProcessor: (exporter, config) =>
    optionsStyle
      ? new mod.BatchSpanProcessor({ exporter, ...config })
      : new mod.BatchSpanProcessor(exporter, config),
  createTracerProvider: (config) => {
    const Provider = mod.TracerProvider ?? mod.BasicTracerProvider;
    return new Provider(config);
  },
  createAlwaysOnSampler: () => new mod.AlwaysOnSampler(),
});

let cached: SdkAdapter | undefined;

/**
 * Resolves the SDK lazily, preferring `sdk-trace` (a v3 host has only that) and
 * falling back to `sdk-trace-base`.
 */
export const getSdkAdapter = (): SdkAdapter => {
  if (cached) {
    return cached;
  }
  try {
    // biome-ignore lint/style/noCommonJs: dynamically resolve whichever SDK line is installed
    cached = buildSdkAdapter(require("@opentelemetry/sdk-trace"), true);
    logger.debug("Laminar is using @opentelemetry/sdk-trace");
  } catch {
    // biome-ignore lint/style/noCommonJs: dynamically resolve whichever SDK line is installed
    cached = buildSdkAdapter(require("@opentelemetry/sdk-trace-base"), false);
    logger.debug("Laminar is using @opentelemetry/sdk-trace-base");
  }
  return cached;
};
