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
- Mastra emits MODEL_GENERATION inputs and MODEL_STEP inputs in AI SDK v5 `ModelMessage` shape (`{role:'assistant', content:[{type:'tool-call',toolCallId,toolName,input},…]}` and `{role:'tool', content:[{type:'tool-result',…}]}`). Laminar's frontend `processMessages` (in `lmnr/frontend/components/traces/span-view/messages.tsx`) selects a parser by shape — AI SDK v5's hyphenated part types match none of Anthropic/OpenAI/GenAI/LangChain/Gemini, so it falls through to the generic converter, which stringifies tool parts and hides tool history after step 1. Normalize to OpenAI Chat Completions shape in the exporter (`normalizeAiSdkV5Messages` in `mastra/exporter.ts`) — including `flatMap` splitting the single `role:'tool'` bundle into one message per `tool_call_id`.
- MODEL_GENERATION output from Mastra is `{text, toolCalls, object, reasoning, …}`, not a chat message. For Laminar rendering, wrap it as a single `{role:'assistant', content, tool_calls}` array (`getLaminarSpanOutput`).
- MODEL_GENERATION and MODEL_STEP both map to Laminar `LLM` span type; MODEL_CHUNK is excluded at the Mastra config layer via `excludeSpanTypes: ["model_chunk"]`.
- `@mastra/observability`'s `normalizeMessages` coerces OpenAI Responses API `body.input` items (`function_call` / `function_call_output` — no `role`/`content`) into `{role:'user', content:''}` artifacts. `cleanMastraNormalizedMessages` strips those before Laminar sees them.
- MODEL_STEP input arrives already destroyed by the normalizer above — the original `function_call`/`function_call_output` payloads are gone. The exporter **reconstructs** step N's input from sibling span state in the same trace: `MODEL_GENERATION.input.messages` (initial) + each prior `MODEL_STEP.output.toolCalls` (assistant turns) + their child `TOOL_CALL` outputs (tool results). Correlation: `TOOL_CALL` spans in Mastra's Responses flow carry NO `toolCallId` — they sit under their requesting `MODEL_STEP` and must be paired by ordinal position with the parent step's `output.toolCalls[i].toolCallId`. Ordering invariant (end events): for each step, child `TOOL_CALL`s end first, then the `MODEL_STEP` ends, so tool outputs are collected in `toolOutputsByStep[stepId]` on TOOL_CALL end and paired with `output.toolCalls[]` on MODEL_STEP end.

## Local verification gotchas

- The shell environment in this sandbox pre-exports `LMNR_PROJECT_API_KEY` pointing at staging, which overrides any value in `/sandbox/scratch/.env` (both `--env-file=.env` and `dotenv/config` are no-ops when the var is already set). Use a dedicated `LMNR_LOCAL_PROJECT_API_KEY` for scripts that should hit the local app-server, and fall back to `LMNR_PROJECT_API_KEY` for CI.
- App-server authenticates project API keys via `Sha3_256(raw_key)` (not SHA-256). Verify with `echo -n "$KEY" | openssl dgst -sha3-256` when debugging 401s.

## Testing

- `pnpm -r build` must run before package tests if workspace deps (`@lmnr-ai/client`, `@lmnr-ai/types`) have changed — tests resolve via `dist/index.cjs`.
- Unit tests use `tsx --test` (Node built-in test runner). Avoid pulling in real vendor SDKs — synthesize events/spans and assert on the OTel output via `InMemorySpanExporter`.
