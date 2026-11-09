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

## OpenTelemetry dependency ranges (`packages/lmnr/package.json`) — LAM-2446

Apps run OTel JS v1 (api 1.9, 0.5x), v2 (api 1.9, 0.2xx) or v3 (api 1.10, 0.3xx). Laminar must work in all of them **and must use the app's `@opentelemetry/api` copy**.

- **Why a second api copy breaks apps.** Every api copy shares one registry, `globalThis[Symbol.for("opentelemetry.js.api.1")]`, stamped with the version of the copy that wrote it first (`internal/global-utils.js`, `semver.js`):
  - Writes need an EXACT version match, patch included.
  - Reads need the same major and a registry minor >= the reader's.
  - So if lmnr has its own api copy and `Laminar.initialize()` writes first (`diag.setLogger`, and the global context manager when none is set), the app's later `trace.setGlobalTracerProvider` returns `false`. The app's own spans then silently go nowhere. This is the app's tracing breaking, not Laminar's.
  - With one shared copy, Laminar going first only makes the app's context-manager registration a harmless duplicate.
  - Verified with bare api copies (1.8.0 / 1.9.0 / 1.9.1 / 1.10.0, any mismatch breaks the app) and on the published `0.8.54` in a v3 app.
- **Why regular dependencies can't do it.** Every OTel 2.x package peers on `api <1.10.0`, and every 3.x / 0.300 package on `api >=1.10.0`. npm resolves each dependency on its own and takes the newest version when the app lacks the package; it doesn't follow the app's api line. Whichever line a dependency resolves to, some app gets a package under `node_modules/@lmnr-ai/lmnr/node_modules` whose peer needs the other api, and npm nests a second api there.
  - Tried and measured: v1/v2 ranges (0.8.54 and the first `dev-0.9.0` attempt) nest `api@1.9.1` in v3 apps; v3 ranges nest `api@1.10` in v1/v2 apps.
  - An optional peer on `@opentelemetry/sdk-trace` made `npm i @lmnr-ai/lmnr` fail outright (`ERESOLVE`) in existing v1 and pre-2.12 v2 apps. npm 11 resolves the optional peer to 3.0.0 against the app's api 1.9. Don't add OTel peers.
- **So the version-locked packages are bundled into dist** (`deps.alwaysBundle` in `tsdown.config.mts`, devDependencies at `^3.0.0` / `^0.300.0`): `core`, `resources`, `sdk-trace`, `exporter-trace-otlp-grpc` / `-proto`, `otlp-exporter-base`, `otlp-grpc-exporter-base`, `otlp-transformer`. npm never sees their peers.
  - **Never bundle `@opentelemetry/api`.** That's a guaranteed second copy.
  - Import the SDK from `@opentelemetry/sdk-trace` (`TracerProvider`, options-object processor constructors), never `sdk-trace-base` / `sdk-trace-node`: those aren't dependencies, so the import only resolves in apps that happen to install them. `tsdown.config.mts` turns rolldown's `UNRESOLVED_IMPORT` into a build error for this reason. It used to be a warning, and pi-durable (#350, branched before the bundling PR) shipped a bare `require("@opentelemetry/sdk-trace-base")` that crashed v3 and fresh apps on import.
  - The bundled v3 code only uses api exports that exist in our floor (api 1.9.0). Tree-shaking drops the logs/metrics serializers, so `logs`, `SeverityNumber` and `createNoopLogger` never get imported. `test/sdk-matrix/check-api-floor.mjs` enforces this on the built dist, because nothing else does: a future 3.x that starts calling a 1.10-only export would break only api 1.9 apps. In ESM that fails at link time; in CJS it's a silent `undefined`.
  - No `.d.ts` references the bundled packages (rolldown-plugin-dts inlines them). Hence the structural `SpanProcessorCompat` / `SpanExporterCompat` option types in `tracing/compat.ts`: v1's span shape isn't assignable to the inlined v3 types.
  - Cost: dist grows by about 150 KB.
  - Behavior change: the v3 SDK no longer reads `OTEL_BSP_*`, `OTEL_SPAN_*_LIMIT`, `OTEL_ATTRIBUTE_*_LIMIT` or `OTEL_TRACES_SAMPLER*` on Laminar's provider.
  - OTel 3 declares Node >=22.15. Our `engines` stays >=22.12: the matrix passes on Node 22.12.0.
- **The remaining runtime OTel deps accept both api lines:**
  - `api` is `^1.9.0`. Keep the floor as low as the bundled code allows: an app below it gets a nested api.
  - `context-async-hooks` is `^1.30.1 || ^2.0.0 || ^3.0.0`; 3.x peers `api >=1.0.0 <1.11.0`.
  - `semantic-conventions`.
  - `instrumentation`, which stays `<0.300.0`. 0.300 reads `logs` from the api in `InstrumentationAbstract`'s constructor, so on api 1.9 `Laminar.initialize()` throws `Cannot read properties of undefined (reading 'getLogger')`. That broke the published `0.8.52`. 0.2xx peers `api ^1.3.0` and runs on both lines. It can't be bundled, because import-in-the-middle registers its ESM hook by file path inside its own package.
- **Host matrix** (`.github/workflows/sdk-matrix.yml` runs it on PRs that touch these files): `node test/sdk-matrix/run.mjs [v1|v2.0|v2.12|v3|fresh]`. It packs the SDK, runs `check-api-floor.mjs` on the packed dist, then adds lmnr to scratch apps on each line. Each app gets its own OTel packages FIRST and lmnr in a SECOND `npm i`; a single combined `npm i` hid the `ERESOLVE` above. It needs network and isn't part of `pnpm test`. Per app it runs:
  - `host-check.cjs`: lmnr resolves the app's api; Laminar runs next to an app-registered provider; `LaminarSpanProcessor` inside an app provider; app spans through the real OTLP exporter.
  - `laminar-first.cjs`: `Laminar.initialize()` before the app's OTel, and the app's provider and spans must still work. This is a separate process because the registry is per process.
  - `esm-smoke.mjs`: the ESM entry.
  - When changing dependencies or bundling, also run it against the previous release's tarball (`LMNR_TARBALL=...`) to confirm the checks still fail where expected.
  - **It runs unlocked third-party code, so it's hardened.** Each run resolves about 150 packages per app straight from npm, with no lockfile. Keep all of the following:
    - in `sdk-matrix.yml`: `permissions: contents: read`, `persist-credentials: false`, actions pinned by commit SHA, and no secrets or `id-token`;
    - in `run.mjs`: `npm i --ignore-scripts --before=<now - MIN_RELEASE_AGE_DAYS>`, and an exact `NEWEST_API`, not `@latest`.
    - Before this, a compromised transitive package would have run its install script with a write-all `GITHUB_TOKEN` readable from `.git/config`: the repo's default token permissions, persisted by `actions/checkout`.
    - npm publishing is unreachable from here regardless: it uses OIDC in `publish-to-npm.yml` only, triggered by `release`, and releases created with `GITHUB_TOKEN` don't start workflows.
    - A version pinned in `HOSTS`, or a fresh dependency bump, has to be older than `MIN_RELEASE_AGE_DAYS` to install.
- To run the unit tests on api 1.10 locally, temporarily add `overrides: { "@opentelemetry/api": "1.10.0" }` to `pnpm-workspace.yaml`. The lockfile pins 1.9.1.

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
- `src/opentelemetry-lib/bridges/AGENTS.md` - `bridges` option: `Bridge` interface + registry, disabling conflicting auto-instrumentations, Langfuse bridge (tracer-provider wrapper, shadow/copy mirroring, self-healing provider slot, attribute translation, 4.x–6.x CI matrix)
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
- `src/opentelemetry-lib/instrumentation/pi-durable/AGENTS.md` - Pi Durable: telemetry adapter + hooks extension, run anchor in the carrier, synthesized root for restarts, settlement-based run end, generation-phase suppression
- `src/opentelemetry-lib/instrumentation/temporal/AGENTS.md` - deterministic sandbox, header propagation, workflow lifecycle span
- `src/browser/stagehand/v3/AGENTS.md` - `sendCDP` fallback for stagehand 3.0.0 / 3.0.1
- `src/integrations/AGENTS.md` - eve `LaminarReporter`
