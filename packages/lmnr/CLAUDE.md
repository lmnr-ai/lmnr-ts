This is the main `@lmnr-ai/lmnr` SDK package — OpenTelemetry-based tracing for the Laminar observability platform.

# Tests
- Tests are run with `pnpm test` which invokes `tsx --test test/*.test.ts test/**/*.test.ts`. No Jest, no Vitest.
- HTTP calls are mocked via `nock` using cassette recordings under `test/recordings/*.json`. `decompressRecordingResponse` (in `test/utils.ts`) handles gzipped payloads; hand-crafted cassettes just set a plain JSON `response`.
- `initializeTracing({ exporter, disableBatch: true })` + `Object.defineProperty(Laminar, "isInitialized", { value: true, writable: true })` is the standard test setup for asserting on exported spans via `InMemorySpanExporter`.

# TypeScript / Build
- `tsc --noEmit` runs with `module: NodeNext` from the repo root `tsconfig.json`. `import.meta.url` in test files triggers TS1470 — use `__dirname` instead (tsx handles both ESM and CJS). Dynamic `await import("../src/...")` of local TS files triggers TS2834 ("needs explicit file extensions") — prefer static imports at the top of the test file for local modules.

# Context / startActiveSpan
- `Laminar.startActiveSpan` activates the span on `LaminarContextManager`'s AsyncLocalStorage stack. Sibling / unrelated async tasks (i.e. callbacks that run outside the returned promise's chain — `setImmediate`, separate timers, independent processor callbacks, etc.) do NOT inherit the activated span — they live in a different ALS frame. For spans that must parent across detached async callbacks, pass `global: true`: the span is pushed onto a process-global stack that `getContext()` falls back to when the ALS stack is empty. The span is popped from that stack automatically in `LaminarSpan.end()`. Use sparingly — it is roughly analogous to Python's `context.attach(...)` / `start_as_current_span` global activation.
- If you pass `context: ...` into `startSpan` / `startActiveSpan` it replaces the usual `LaminarContextManager.getContext()` base — so if you need the global fallback, build your context on top of `LaminarContextManager.getContext()` rather than on `otelContext.active()`.

# OpenTelemetry Instrumentations
- Instrumentations live under `src/opentelemetry-lib/instrumentation/<name>/` and are registered in `src/opentelemetry-lib/tracing/instrumentations.ts` (both auto-registration path and the `manuallyInitInstrumentations` path — keep the two in sync).
- For manual instrumentation, expose an option key on `InitializeOptions.instrumentModules` and wire it through `manuallyInitInstrumentations`.
- `TracingProcessor` from `@openai/agents` requires the interface methods return `Promise`. Most of our methods have no `await` — add a file-level `/* eslint-disable @typescript-eslint/require-await */` around the class rather than sprinkling `await Promise.resolve()`.
- `@openai/agents` re-exports types and classes from `@openai/agents-core` and `@openai/agents-openai`. Import from `@openai/agents` to avoid adding `-core`/`-openai` as direct dependencies.
- When patching prototypes registered via multiple `InstrumentationNodeModuleDefinition` entries that resolve to the same class (e.g. `@openai/agents` and `@openai/agents-openai` both expose `OpenAIResponsesModel.prototype`), guard `_wrap` with a `WeakSet` of already-wrapped prototypes — `shimmer` happily double-wraps and will run your wrapper logic twice per call.
- `AsyncLocalStorage.run(value, fn)` restores the previous context as soon as `fn` returns — for async iterables/streams, wrap **each** `next()`/`return()`/`throw()` call in its own `.run()` so the context is visible across yields, not just at iterator creation.

# Agents SDK — TS vs Python parity
- TS `ModelRequest` puts `systemInstructions` as a top-level field (not inside a kwargs bag like Python). The Python wrapper extracts it from `kwargs`; the TS wrapper reads `request.systemInstructions`.
- TS agents span_data uses private fields `_response` and `_input` (not `response` / `input`). The Python handlers read the public field names — when porting, check both.
- Manual instrumentation in tests: call `setTracingDisabled(false)` + `setTraceProcessors([])` first to clear any globally registered processors, then pass a `manuallyInstrument({ addTraceProcessor, OpenAIResponsesModel, OpenAIChatCompletionsModel })` shim that forwards to `setTraceProcessors([p])`.
