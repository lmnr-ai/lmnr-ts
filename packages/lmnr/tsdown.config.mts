import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/cli-dev.ts",              // Wrapper for lmnr-cli binary
    "src/cli/worker/index.ts",     // TypeScript worker
    "src/cli/worker/ts-parser.ts", // TypeScript parser (needed by CLI)
    "src/cli/worker/build.ts"      // Build utilities (needed by CLI)
  ],
  format: ["cjs", "esm"], // Build for commonJS and ESmodules
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  external: [
    "puppeteer",
    "puppeteer-core",
    "playwright",
    "esbuild",
  ],
  noExternal: [
    "@lmnr-ai/types",
    "@lmnr-ai/client",
    "export-to-csv",
    "csv-parser",
  ],
});
