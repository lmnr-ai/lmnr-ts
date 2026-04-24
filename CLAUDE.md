# lmnr-ts — Agent notes

## Build / tsdown gotchas

- `tsdown` bundles types via `rolldown-plugin-dts`, which follows **every** imported type graph. Importing types from `@mastra/core` or `@mastra/observability` pulls in `@mastra/schema-compat/dist/json-schema/index.d.ts`, which references a `./json-schema/index.js` that does not exist — the dts build then fails with "Module not found."
- Workaround: redeclare the subset of external types you use as a local structural shim (see `packages/lmnr/src/opentelemetry-lib/instrumentation/mastra/types.ts`) and load runtime classes via `require(...)` with a fallback class. This keeps the dependency optional and avoids poisoning `dist/index.d.mts`.
- `deps.neverBundle` in `tsdown.config.mts` controls runtime bundling only — it does **not** exclude types from the dts build. Use structural shims to keep types out.

## Mastra instrumentation

- Mastra has its own observability bus (`@mastra/core/observability`) with rich semantic span types (`agent_run`, `model_generation`, `tool_call`, `workflow_*`, etc.). The AI-SDK-based fallback produces duplicate/noisy spans — prefer the native bus by injecting `LaminarMastraExporter` into `observability.configs.default.exporters`.
- Auto-injection patches `@mastra/core`'s `Mastra` constructor via `MastraInstrumentation`. For ESM / pre-bundled setups where the hook does not fire, users should call `withLaminar(config)` manually.
- `manuallyInstrument(input)` must receive the module exports object (i.e. the holder of `{ Mastra }`), not the raw class — wrapping a bare class cannot replace callers' references. It reuses the same `patch` path as the require-hook, so the exporter is actually injected (setting a prototype marker alone is a no-op).
- Preserve trace/parent hierarchy by using Mastra's own `traceId` / `parentSpanId` directly when converting to `ReadableSpan`; don't route through Laminar's `onStart` path builder — Mastra provides complete hierarchy metadata.
- `@mastra/core` 1.27+ `TracingEventType` uses underscore-separated values (`span_started`, `span_ended`) — not the colon form (`span:started`) shown in older docs. A stale enum value silently drops every event, so `MastraTracingEventType` in `mastra/types.ts` must stay in sync.
- `@mastra/core` 1.27+ rejects raw `{ configs: { default: {...} } }` registry-config objects on `Mastra`'s `observability` field — it expects an `Observability` instance (has `getDefaultInstance()`). Construct one via `new Observability({ configs: {...} })` loaded through `require("@mastra/observability")` so the dep stays optional.

## Local verification gotchas

- The shell environment in this sandbox pre-exports `LMNR_PROJECT_API_KEY` pointing at staging, which overrides any value in `/sandbox/scratch/.env` (both `--env-file=.env` and `dotenv/config` are no-ops when the var is already set). Use a dedicated `LMNR_LOCAL_PROJECT_API_KEY` for scripts that should hit the local app-server, and fall back to `LMNR_PROJECT_API_KEY` for CI.
- App-server authenticates project API keys via `Sha3_256(raw_key)` (not SHA-256). Verify with `echo -n "$KEY" | openssl dgst -sha3-256` when debugging 401s.

## Testing

- `pnpm -r build` must run before package tests if workspace deps (`@lmnr-ai/client`, `@lmnr-ai/types`) have changed — tests resolve via `dist/index.cjs`.
- Unit tests use `tsx --test` (Node built-in test runner). Avoid pulling in real vendor SDKs — synthesize events/spans and assert on the OTel output via `InMemorySpanExporter`.
