# `@lmnr-ai/lmnr` package

This is the main Laminar SDK for TypeScript/Node.js. It provides the Laminar client, tracing helpers, decorators, and per-library instrumentations under `src/opentelemetry-lib/instrumentation/`.

## Testing
- Unit tests use Node's built-in test runner via `tsx --test`. Run a single file with `npx tsx --test test/<name>.test.ts`.
- Tests rely on `InMemorySpanExporter` (from `@opentelemetry/sdk-trace-base`) instead of a real backend — inject one through the exporter/processor config.
- `npx tsc --noEmit` currently has pre-existing errors in unrelated files (`import.meta` in CommonJS builds, google-genai type mismatch). Treat a green result for the files you touched as the bar; do not try to fix the rest as part of your task.

## Instrumentation patterns
- Library-specific instrumentations live in `src/opentelemetry-lib/instrumentation/<library>/`. Each exposes either a wrapper (e.g. `wrapAISDK`) or a dedicated exporter class (e.g. `LaminarMastraExporter`) from `src/index.ts`.
- When integrating with a library that ships its own tracing (like Mastra), prefer implementing an exporter that transforms into OTel `ReadableSpan` and forwards through `LaminarSpanExporter`. Do NOT add the third-party SDK as a hard dep — declare it as an optional peer and duplicate the structural types locally so consumers who don't use that library aren't forced to install it.
- Span path tracking (`lmnr.span.path` / `lmnr.span.ids_path`) must be built on SPAN_STARTED and finalized on SPAN_ENDED. Clean up trace state when `activeSpanIds` becomes empty to avoid memory leaks for long-running processes.
- For OTel v1/v2 compat on emitted `ReadableSpan` objects, set BOTH `parentSpanId` + `parentSpanContext`, AND `instrumentationLibrary` + `instrumentationScope`. Different downstream processors read different fields depending on the installed `@opentelemetry/sdk-trace-base` version.
- When computing `HrTime` deltas, subtract `[seconds, nanoseconds]` component-wise with borrow handling. Do NOT collapse to total nanoseconds via `s * 1e9 + ns` — current Unix second values (~1.7e9) overflow `Number.MAX_SAFE_INTEGER` once multiplied by 1e9, causing precision loss in the resulting duration.

## Mastra exporter specifics
- Mastra `SpanType` enum values serialize as snake_case strings (`'model_step'`, not `'MODEL_STEP'`).
- Span type mapping to Laminar: `model_step` → `LLM`, `tool_call`/`mcp_tool_call` → `TOOL`, everything else → `DEFAULT`. `model_chunk` is dropped (extremely noisy streaming events).
- `model_generation` represents the whole agent/LLM flow and must stay `DEFAULT` — it is NOT a single LLM call. The single LLM call is `model_step`.
- Flatten `input.messages` to the top of `lmnr.span.input` for `model_generation` so the Laminar chat UI renders messages correctly.

## Linting
- `npx eslint <paths>` — lint ONLY the files you touched; do not run project-wide linting.
- `@typescript-eslint/require-await`: methods tagged `async` must contain an `await`. If you only have early returns, drop `async` and return `Promise.resolve()` explicitly.
- `@typescript-eslint/no-unused-vars`: unused parameters (even `_`-prefixed in some configs) may fail — omit them entirely when not needed.
