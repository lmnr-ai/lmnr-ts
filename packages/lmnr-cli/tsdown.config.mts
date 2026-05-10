import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"], // CLI is Node.js only
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: ["@lmnr-ai/types", "@lmnr-ai/client"],
  },
});
