import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
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
    ],
  },
});
