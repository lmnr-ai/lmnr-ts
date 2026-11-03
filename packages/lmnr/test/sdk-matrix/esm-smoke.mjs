// Runs inside a scratch app (see run.mjs): imports the ESM entry and traces one
// call. ESM is stricter than CJS: a named import that the app's
// `@opentelemetry/api` doesn't export fails at link time instead of being
// `undefined`.
import { Laminar, observe } from "@lmnr-ai/lmnr";

Laminar.initialize({
  projectApiKey: "x",
  baseUrl: "http://127.0.0.1",
  grpcPort: 1,
  writeTrajectory: false,
});
const result = await observe({ name: "esm" }, async () => 42);
if (result !== 42) {
  throw new Error(`observe returned ${result}`);
}
console.log(`${process.argv[2]}: esm ok`);
process.exit(0);
