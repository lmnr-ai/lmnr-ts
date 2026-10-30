This is the main `@lmnr-ai/lmnr` SDK package — OpenTelemetry-based tracing for the Laminar observability platform.

Module-specific notes live in nested `AGENTS.md` files next to the code (each with a `CLAUDE.md` symlink so Claude Code loads it on demand). Read the relevant one before editing a module; the index is at the bottom of this file.

## Tests

- `pnpm test` runs `tsx --test` (node:test, no Jest / Vitest) with nock cassettes under `test/recordings/`. Setup patterns and cassette pitfalls: `test/AGENTS.md`.

## Evaluations memory model (`src/evaluations.ts`, `src/datasets.ts`) — LAM-1909

- **Evals consume the dataset ONLY through `for await (const dp of this.data)`, never by materializing it.** `EvaluationDataset[Symbol.asyncIterator]` defaults to walking `size()` + `get(i)`, so custom datasets (size + by-index contract only) keep working unchanged. `LaminarDataset` overrides it to stream page by page via `pullPage` (fetch WITHOUT caching), holding at most one page. `get` / `size` still go through `fetchPage`, which caches every page, so random access keeps its old accumulate-and-cache behavior. `run()` calls `getLength()` → `size()` for the progress bar, which caches page 0; the iterator serves cached pages from `this.pages`, so that page is not re-pulled (pinned by `pulls a LaminarDataset page by page without caching streamed pages` in `test/evaluate.test.ts`). Peak memory is about `concurrencyLimit` in-flight datapoints plus one page (plus page 0). Known gap, shared with Python: `take` / `select` / `shuffle` wrappers (`Transformed`) use the default iterator → `base.get` → still cache every page they touch.
- **`fetchSize` (page size) and `concurrencyLimit` are deliberately decoupled.** The semaphore provides backpressure: the loop `await semaphore.acquire()`s BEFORE scheduling, so the iterator stops pulling when `concurrencyLimit` tasks are in flight. This is a sliding window, not batch barriers. Finished tasks remove themselves from the `inFlight` Set.
- **Never gather-then-aggregate.** `evaluateInBatches` returns the average scores, built from running `scoreSums` / `scoreCounts` that skip nulls. Keys whose scores are all null (human evaluators) are OMITTED, matching Python `get_average_scores`. The old helper produced `NaN` for them and reset the sum on a null.
- **The two failure paths behave differently, on purpose (mirrors Python #313).**
  - Trial errors: every Trial is still scheduled. The first error is recorded and thrown only after `inFlight` drains, so a failure surfaces after at most `concurrencyLimit` in-flight Trials finish. `run()`'s catch then skips the upload drain, which is the pre-existing behavior.
  - Upload (`saveDatapoints`) errors: these go through `trackUpload`, which attaches the rejection handler IMMEDIATELY and stores the first error in `uploadError`. `run()` awaits every pending save and only then rethrows. The immediate handler is load-bearing: the old code pushed bare promises into an array and awaited them only at the end, so a save that rejected while the eval was still running produced an `unhandledRejection` (verified: node:test reported "generated asynchronous activity after the test ended … unhandledRejection").
- **Task ids (`taskId`) are the one per-run accumulation.** `createTaskIdResolver` keeps a `sourceIndex → taskId` map and a set of taken ids (strings only, no payloads) so a duplicate from a DIFFERENT source row becomes `id#2`, while the same source row seen twice (`select([0, 0])`) keeps its id. The default id is `String(sourceIndex)`, where `EvaluationDataset.sourceIndex` maps a view index back through every `Transformed` wrapper. `trials` schedules each Task N times; its Trials share `index = viewIndex` and the taskId.
- **Unlike Python, there is no `run_in_executor` step.** The TS client is already async, so a save never blocks the event loop.

## TypeScript / Build

- `tsc --noEmit` runs with `module: preserve` + `moduleResolution: bundler` from the repo root `tsconfig.json`, because tsc NEVER emits here — tsdown/rolldown owns the dual CJS+ESM build. Under the previous `NodeNext`, a package without `"type": "module"` made every `.ts` file CommonJS in tsc's eyes, so `import.meta.url` was a hard TS1470 error even though rolldown rewrites it correctly per-format. Both `import.meta.url` and `__dirname` are now legal (tsx handles both at test time). Tradeoff: tsc no longer enforces Node's ESM/CJS interop rules — extensionless relative imports and `await import("../src/...")` of local TS files (formerly TS2834) both pass now, since the emitted code is bundled and never hits Node's resolver.

## OpenTelemetry dependency ranges (`packages/lmnr/package.json`)

The SDK must work in host apps on OTel JS v1 (api 1.9, 0.5x), v2 (api 1.9, 0.2xx) and v3 (api 1.10, 0.3xx), and must share the host's `@opentelemetry/api` instance (LAM-2446).

- **The invariant: no npm dependency of the SDK may peer on a range of `@opentelemetry/api` that excludes 1.9 or 1.10.**
  - Every OTel 2.x stable package peers on `api <1.10.0`. Every 3.x package (and the 0.300 packages built on them) peers on `api >=1.10.0`.
  - npm resolves each dependency on its own, and picks the highest version when the host doesn't have the package. It does NOT follow the host's api line.
  - When such a package lands in `node_modules/@lmnr-ai/lmnr/node_modules`, npm nests a second `@opentelemetry/api` there to satisfy its peer. The SDK then has its own api instance, separate from the host's.
  - A split api breaks globals both ways. The OTel api only accepts a registered global whose minor version is >= its own, and registrations must match versions exactly. Verified on the published `0.8.54` in a v3 app: lmnr got a nested `api@1.9.1`, and when `Laminar.initialize()` ran first, the host's `trace.setGlobalTracerProvider` returned `false` and the host's active span was invisible.
- **So the version-locked OTel packages are bundled into dist, not dependencies** (`deps.alwaysBundle` in `tsdown.config.mts`, devDependencies at `^3.0.0` / `^0.300.0`): `core`, `resources`, `sdk-trace`, `exporter-trace-otlp-grpc` / `-proto`, `otlp-exporter-base`, `otlp-grpc-exporter-base`, `otlp-transformer`.
  - The bundled v3 code only uses api symbols that also exist in api 1.9.1. Tree-shaking drops the logs/metrics serializers, so `SeverityNumber` / `ValueType` / `logs` (api 1.10 only) never get imported.
  - **The ESM build is stricter than CJS.** `otlp-transformer@0.300`'s ESM statically imports `SeverityNumber`, so on api 1.9 the ESM entry fails at link time ("does not provide an export named"). CJS just gets `undefined`. After changing bundling, grep `dist/index.mjs` for its `import { ... } from "@opentelemetry/api"` line and check every name exists in api 1.9.1.
  - There are no `.d.ts` references to the bundled packages either (rolldown-plugin-dts inlines them).
- **The remaining runtime OTel deps accept both api lines:** `api` (`^1.9.1`, dedupes to the host's), `context-async-hooks` (`^1.30.1 || ^2.0.0 || ^3.0.0`; 3.x peers `api >=1.0.0 <1.11.0`), `semantic-conventions`, and `instrumentation`.
- **`instrumentation` stays capped `<0.300.0`.** `0.300.0` reads `logs` from the api in `InstrumentationAbstract`'s constructor, so with api 1.9 `Laminar.initialize()` throws `Cannot read properties of undefined (reading 'getLogger')`. That's what broke the published `0.8.52`, where open `>=0.200.0` ranges let a fresh npm install pick 0.300. 0.2xx peers `api ^1.3.0`, so it runs on both lines. It can't be bundled: its require/import-in-the-middle hooks have to be the real packages.
- `sdk-node` was a dependency but was never imported. It was removed because its 0.2xx pulled in the whole v2 SDK.
- The `@traceloop/instrumentation-*` deps pin `core ^2.0.1`. In a v3 app those land under each traceloop package (they're hoisted to root), not under lmnr, so they don't split lmnr's api.
- **Check dependency changes with clean npm installs, not just the workspace.** The lockfile hides resolution problems. Run `pnpm pack`, then `npm i <tarball>` into empty apps that already have each OTel line: v1 (`api@1.9.1`, `sdk-trace-base@1.30.1`), v2 without `sdk-trace` (`sdk-trace-base@2.0.0`), v2.12, v3 (`api@1.10.0`, `sdk-trace@3`, `sdk-node@0.300`), and fresh. In each, check that `require.resolve("@opentelemetry/api")` from the lmnr package equals the host's. Then run `Laminar.initialize()` + `observe()` from both the CJS and the ESM entry.
- To run the test suite on api 1.10 locally, temporarily add `overrides: { "@opentelemetry/api": "1.10.0" }` to `pnpm-workspace.yaml`. The lockfile pins 1.9.1.

## Environment variables

```
LMNR_PROJECT_API_KEY  # API key (can also pass to initialize())
LMNR_BASE_URL         # API base URL
LMNR_RELEASE          # Release (git SHA) stamped on spans; auto-detected if unset
LMNR_TRAJECTORY_PATH  # Write the run as an lmnr-atif (ATIF) file; local-only, no key needed. May contain {trace_id}, {pid}
LMNR_TRAJECTORY_FORCE_EXPORT  # With LMNR_TRAJECTORY_PATH: also export spans to Laminar
```

## Nested AGENTS.md files

- `test/AGENTS.md` - test runner, nock cassettes and `content-encoding` replay, standard span-export setup, `.lmnr/` leak guard
- `src/debug/AGENTS.md` - debug mode / replay (server-cache v2), `.lmnr/debug-session.json`, propagated `debug` context, Python parity
- `src/trajectory/AGENTS.md` - lmnr-atif (ATIF trajectory) reader / normalizer / builder / writer: port of lmnr-python, shared `spec/lmnr-atif/` (never edit here), `py.ts` Python-semantics helpers, golden suite
- `src/opentelemetry-lib/tracing/AGENTS.md` - `startActiveSpan` / context stack, byte-size batch flush, span payload size limit, release stamp, trajectory file (`LMNR_TRAJECTORY_PATH` modes, collector, exit hook, precise span times)
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
