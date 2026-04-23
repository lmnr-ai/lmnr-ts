# lmnr-ts — Agent notes

## Build / tsdown gotchas

- `tsdown` bundles types via `rolldown-plugin-dts`, which follows **every** imported type graph. Importing types from `@mastra/core` or `@mastra/observability` pulls in `@mastra/schema-compat/dist/json-schema/index.d.ts`, which references a `./json-schema/index.js` that does not exist — the dts build then fails with "Module not found."
- Workaround: redeclare the subset of external types you use as a local structural shim (see `packages/lmnr/src/opentelemetry-lib/instrumentation/mastra/types.ts`) and load runtime classes via `require(...)` with a fallback class. This keeps the dependency optional and avoids poisoning `dist/index.d.mts`.
- `deps.neverBundle` in `tsdown.config.mts` controls runtime bundling only — it does **not** exclude types from the dts build. Use structural shims to keep types out.

## Mastra instrumentation

- Mastra has its own observability bus (`@mastra/core/observability`) with rich semantic span types (`agent_run`, `model_generation`, `tool_call`, `workflow_*`, etc.). The AI-SDK-based fallback produces duplicate/noisy spans — prefer the native bus by injecting `LaminarMastraExporter` into `observability.configs.default.exporters`.
- Auto-injection patches `@mastra/core`'s `Mastra` constructor via `MastraInstrumentation`. For ESM / pre-bundled setups where the hook does not fire, users should call `withLaminar(config)` manually.
- Preserve trace/parent hierarchy by using Mastra's own `traceId` / `parentSpanId` directly when converting to `ReadableSpan`; don't route through Laminar's `onStart` path builder — Mastra provides complete hierarchy metadata.

## Testing

- `pnpm -r build` must run before package tests if workspace deps (`@lmnr-ai/client`, `@lmnr-ai/types`) have changed — tests resolve via `dist/index.cjs`.
- Unit tests use `tsx --test` (Node built-in test runner). Avoid pulling in real vendor SDKs — synthesize events/spans and assert on the OTel output via `InMemorySpanExporter`.
