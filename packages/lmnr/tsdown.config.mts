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
  // An import that resolves to no installed package is otherwise only a
  // warning, and rolldown leaves it as a bare `require` in dist. It then fails
  // in every app that doesn't happen to have that package, e.g. an import of
  // `@opentelemetry/sdk-trace-base` after it stopped being a dependency.
  inputOptions: (options) => ({
    ...options,
    onLog: (level, log, defaultHandler) => {
      if (log.code === "UNRESOLVED_IMPORT") {
        defaultHandler("error", log);
        return;
      }
      if (options.onLog) options.onLog(level, log, defaultHandler);
      else defaultHandler(level, log);
    },
  }),
  deps: {
    neverBundle: ["puppeteer", "puppeteer-core", "playwright", "esbuild"],
    alwaysBundle: [
      "@lmnr-ai/types",
      "@lmnr-ai/client",
      "export-to-csv",
      "csv-parser",
      // The OTel SDK packages that pin `@opentelemetry/api` to one release
      // line (2.x: api <1.10, 3.x: api >=1.10). As npm dependencies they make
      // npm nest a second api under lmnr in apps on the other line, which
      // splits the global OTel registry. Bundled, they use the app's api.
      // Never add `@opentelemetry/api` here. See AGENTS.md "OpenTelemetry
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
