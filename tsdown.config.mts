import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/cli/rollout/worker.ts"],
  format: ["cjs", "esm"], // Build for commonJS and ESmodules
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  external: ["puppeteer", "puppeteer-core", "playwright", "esbuild"],
  noExternal: ["export-to-csv", "csv-parser"],
});
