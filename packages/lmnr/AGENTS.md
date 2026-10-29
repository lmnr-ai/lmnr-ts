This is the main `@lmnr-ai/lmnr` SDK package — OpenTelemetry-based tracing for the Laminar observability platform.

Module-specific notes live in nested `AGENTS.md` files next to the code (each with a `CLAUDE.md` symlink so Claude Code loads it on demand). Read the relevant one before editing a module; the index is at the bottom of this file.

## Tests

- `pnpm test` runs `tsx --test` (node:test, no Jest / Vitest) with nock cassettes under `test/recordings/`. Setup patterns and cassette pitfalls: `test/AGENTS.md`.

## Evaluations memory model (`src/evaluations.ts`, `src/datasets.ts`) — LAM-1909

- **Evals consume the dataset ONLY through `for await (const dp of this.data)`, never by materializing it.** `EvaluationDataset[Symbol.asyncIterator]` defaults to walking `size()` + `get(i)`, so custom datasets (size + by-index contract only) keep working unchanged. `LaminarDataset` overrides it to stream page by page via `pullPage` (fetch WITHOUT caching), holding at most one page. `get` / `size` still go through `fetchPage`, which caches every page, so random access keeps its old accumulate-and-cache behavior. `run()` calls `getLength()` → `size()` for the progress bar, which caches page 0; the iterator serves cached pages from `this.pages`, so that page is not re-pulled (pinned by `pulls a LaminarDataset page by page without caching streamed pages` in `test/evaluate.test.ts`). Peak memory is about `concurrencyLimit` in-flight datapoints plus one page (plus page 0). Known gap, shared with Python: `take` / `select` / `shuffle` wrappers (`Transformed`) use the default iterator → `base.get` → still cache every page they touch.
- **`fetchSize` (page size) and `concurrencyLimit` are deliberately decoupled.** The semaphore provides backpressure: the loop `await semaphore.acquire()`s BEFORE scheduling, so the iterator stops pulling when `concurrencyLimit` tasks are in flight. This is a sliding window, not batch barriers. Finished tasks remove themselves from the `inFlight` Set.
- **Never gather-then-aggregate.** `evaluateInBatches` returns the average scores, built from running `scoreSums` / `scoreCounts` that skip nulls. Keys whose scores are all null (human evaluators) are OMITTED, matching Python `get_average_scores`. The old helper produced `NaN` for them and reset the sum on a null.
- **The two failure paths behave differently, on purpose (mirrors Python #313).**
  - Datapoint errors: every datapoint is still scheduled. The first error is recorded and thrown only after `inFlight` drains, so a failure surfaces after at most `concurrencyLimit` in-flight tasks finish. `run()`'s catch then skips the upload drain, which is the pre-existing behavior.
  - Upload (`saveDatapoints`) errors: these go through `trackUpload`, which attaches the rejection handler IMMEDIATELY and stores the first error in `uploadError`. `run()` awaits every pending save and only then rethrows. The immediate handler is load-bearing: the old code pushed bare promises into an array and awaited them only at the end, so a save that rejected while the eval was still running produced an `unhandledRejection` (verified: node:test reported "generated asynchronous activity after the test ended … unhandledRejection").
- **Unlike Python, there is no `run_in_executor` step.** The TS client is already async, so a save never blocks the event loop.

## TypeScript / Build

- `tsc --noEmit` runs with `module: preserve` + `moduleResolution: bundler` from the repo root `tsconfig.json`, because tsc NEVER emits here — tsdown/rolldown owns the dual CJS+ESM build. Under the previous `NodeNext`, a package without `"type": "module"` made every `.ts` file CommonJS in tsc's eyes, so `import.meta.url` was a hard TS1470 error even though rolldown rewrites it correctly per-format. Both `import.meta.url` and `__dirname` are now legal (tsx handles both at test time). Tradeoff: tsc no longer enforces Node's ESM/CJS interop rules — extensionless relative imports and `await import("../src/...")` of local TS files (formerly TS2834) both pass now, since the emitted code is bundled and never hits Node's resolver.

## OpenTelemetry dependency ranges (`packages/lmnr/package.json`)

- **Every 0.x OTel package is capped `<0.300.0`**, and the stable packages are capped at `^2.0.0`.
  - The 0.x packages are `instrumentation`, `sdk-node`, `exporter-trace-otlp-*`, `otlp-*-exporter-base`.
  - The stable ones are `core`, `resources`, `sdk-trace-*`, `context-async-hooks`.
  - Together those caps keep the SDK on one OTel release line.
- **Why the cap:** `0.300.0` ships with the OTel 3.0 line (`core` / `resources` 3.0.0), and its packages peer on `@opentelemetry/api >=1.10.0`. Every `2.x` stable package peers on `api <1.10.0`.
- **What broke before the cap:** with the old open `>=0.200.0` ranges, a fresh `npm install` picked `instrumentation@0.300.0` and gave it the SDK's nested `api@1.9.1`, which has no `logs` export.
  - `Laminar.initialize()` then threw `Cannot read properties of undefined (reading 'getLogger')` in `InstrumentationAbstract`'s constructor.
  - Verified on the published `0.8.52`.
  - Existing lockfiles and `pnpm` installs of this repo were unaffected, so CI never saw it.
- Moving to OTel 3.0 / api 1.10 is its own migration: raise the 0.x caps, the `^2.0.0` caps and `api` together. Raising just one range brings the crash back.
- **Check dependency changes with a clean npm install**: `pnpm pack`, then `npm i <tarball>` in an empty dir and call `Laminar.initialize()`. The workspace lockfile hides resolution problems like this one.

## Nested AGENTS.md files

- `test/AGENTS.md` - test runner, nock cassettes and `content-encoding` replay, standard span-export setup, `.lmnr/` leak guard
- `src/debug/AGENTS.md` - debug mode / replay (server-cache v2), `.lmnr/debug-session.json`, propagated `debug` context, Python parity
- `src/opentelemetry-lib/tracing/AGENTS.md` - `startActiveSpan` / context stack, byte-size batch flush, span payload size limit, release stamp
- `src/opentelemetry-lib/instrumentation/AGENTS.md` - `LaminarInstrumentation` base class, `wrapMethod`, shared helpers (`toJson`, `recordSpanError`, `traceCall`, `instrumentStream`), instrumentation scope / package version stamping, registering instrumentations, ALS across async iterators, `makeSpanOtelV2Compatible`, OpenCode
- `src/opentelemetry-lib/instrumentation/aisdk/AGENTS.md` - AI SDK v7 telemetry integration, debug replay consumer
- `src/opentelemetry-lib/instrumentation/anthropic/AGENTS.md` - `APIPromise` preservation, in-place stream wrapping, built-in SDK OTel
- `src/opentelemetry-lib/instrumentation/claude-agent-sdk/AGENTS.md` - settings.json precedence over process env, proxy flag settings
- `src/opentelemetry-lib/instrumentation/cohere/AGENTS.md` - v1 / v2 patch targets, `HttpResponsePromise`, NDJSON vs SSE streams
- `src/opentelemetry-lib/instrumentation/google-aiplatform/AGENTS.md` - Vertex AI via google-genai helpers, `predict` overloads
- `src/opentelemetry-lib/instrumentation/langchain/AGENTS.md` - callback handler injection, provider handoff, LangGraph topology
- `src/opentelemetry-lib/instrumentation/mastra/AGENTS.md` - `MastraExporter`, span-type mapping, context linking, thinking tokens, host app setup
- `src/opentelemetry-lib/instrumentation/openai/AGENTS.md` - patch targets, streams, post-hoc Responses spans, Decisions
- `src/opentelemetry-lib/instrumentation/openai-agents/AGENTS.md` - TS vs Python parity, parent resolution, out-of-order span ends
- `src/opentelemetry-lib/instrumentation/openrouter/AGENTS.md` - per-resource methods, embeddings input shapes, `callModel`, cassettes
- `src/opentelemetry-lib/instrumentation/temporal/AGENTS.md` - deterministic sandbox, header propagation, workflow lifecycle span
- `src/browser/stagehand/v3/AGENTS.md` - `sendCDP` fallback for stagehand 3.0.0 / 3.0.1
- `src/integrations/AGENTS.md` - eve `LaminarReporter`
