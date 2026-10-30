import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/opentelemetry-lib/instrumentation/temporal/workflow-interceptors.ts",
    "src/cli.ts",
  ],
  format: ["cjs", "esm"], // Build for commonJS and ESmodules
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      "puppeteer",
      "puppeteer-core",
      "playwright",
      "esbuild",
      "together-ai",
    ],
    alwaysBundle: [
      "@lmnr-ai/types",
      "@lmnr-ai/client",
      "export-to-csv",
      "csv-parser",
      // Bundled so that they are not npm dependencies: these pin
      // `@opentelemetry/api` to one OTel release line, which would split
      // the SDK's api from the host app's. See AGENTS.md "OpenTelemetry
      // dependency ranges".
      "@opentelemetry/core",
      "@opentelemetry/exporter-trace-otlp-grpc",
      "@opentelemetry/exporter-trace-otlp-proto",
      "@opentelemetry/otlp-exporter-base",
      "@opentelemetry/otlp-grpc-exporter-base",
      "@opentelemetry/otlp-transformer",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-trace",
    ],
  },
});
