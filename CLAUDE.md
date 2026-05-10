# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

Laminar TypeScript SDK — a pnpm monorepo publishing `@lmnr-ai/lmnr`, `@lmnr-ai/client`, `@lmnr-ai/types`, and `lmnr-cli`.

## Repository Structure

- `packages/lmnr` — main `@lmnr-ai/lmnr` package: tracing, OpenTelemetry instrumentations, custom framework exporters (Mastra, Vercel AI SDK, OpenAI, etc.).
- `packages/client` — typed HTTP client for the Laminar API (`@lmnr-ai/client`).
- `packages/types` — shared type defs.
- `packages/lmnr-cli` — `lmnr` CLI.

## Development Commands

```bash
pnpm install                    # Install across workspace
pnpm -r build                   # Build all packages
pnpm -r test                    # Run tests in all packages
pnpm -r lint                    # Lint all packages
pnpm check-versions             # Verify package versions are aligned
```

Work inside a specific package with `pnpm --filter @lmnr-ai/lmnr ...` or `cd packages/lmnr && pnpm ...`.

## Mastra Exporter (`packages/lmnr/src/opentelemetry-lib/instrumentation/mastra/`)

Laminar ships its own `MastraExporter` (implements `ObservabilityExporter` from `@mastra/core/ai-tracing`) instead of relying on the `@mastra/laminar` package. Key non-obvious facts:

- **Span-type mapping**:
  - `MODEL_STEP` → Laminar LLM span (one LLM turn; produces `ai.prompt.messages` / `ai.response.text` / `ai.response.toolCalls`).
  - `TOOL_CALL` / `MCP_TOOL_CALL` → Laminar TOOL span.
  - `MODEL_GENERATION` → Laminar DEFAULT span (the whole agent loop, parent of `MODEL_STEP` and `TOOL_CALL` children).
  - `MODEL_CHUNK` → not exported as spans, but reasoning chunks are intercepted to capture thinking text (see bullet below).
- **Mastra `MODEL_STEP.input` is lossy across steps** — after step 0, tool-result messages show up as empty user messages. We reconstruct the real per-step message history by tracking the parent `MODEL_GENERATION` baseMessages + accumulating per-step turns (assistant tool-call + tool tool-result) from child `TOOL_CALL` spans.
- **`TOOL_CALL` children end BEFORE their parent `MODEL_STEP` ends.** Pair them at *step-end time* against the declared `output.toolCalls` by arrival order — do NOT try to pair them when the tool span ends (declared toolCalls are not available yet).
- Tool-result messages are emitted as `{role:"tool", tool_call_id, content:[{type:"tool-result", toolCallId, toolName, output}]}` — this matches what Laminar's backend (`app-server/src/language_model/chat_message.rs`) expects via `InstrumentationChatMessageAISDKToolCall`/`ToolResult`.
- Exporter internals use narrow local interfaces instead of importing `@mastra/core` types, so there is no peer dep on Mastra.
- **`MastraExporter` requires `Laminar.initialize()` to have been called first.** It owns no transport/batching config and creates spans via `getTracerProvider().getTracer(...)` (NOT `trace.getTracer(...)`, which would return a Noop because Laminar deliberately doesn't register globally — see `tracing/index.ts`). Spans flow through Laminar's `LaminarSpanProcessor` automatically on `Span.end()`. If Laminar isn't initialized the tracer is a noop, `startOtelSpan` sees a `NonRecordingSpan` and drops the span after a one-time warn (`warnNotInitializedOnce`). The only options on `MastraExporterOptions` are `realtime` (force-flush after each span end) and `linkToActiveContext`.
- **Mastra-id alignment is done by mutating the live span.** `startOtelSpan` calls `tracer.startSpan(...)`, then `Object.assign`s Mastra-derived `traceId`/`spanId` over the SDK-allocated ones in `otelSpan.spanContext()` and patches both `parentSpanContext` (SDK v2) and `parentSpanId` (SDK v1 alias). Because the span goes through `LaminarSpanProcessor.onStart` *before* the mutation, it stamps `lmnr.span.path` / `lmnr.span.ids_path` using the auto-generated id; `startOtelSpan` overwrites those attributes with the Mastra-derived versions afterwards. The live span is parked in `liveOtelSpanByMastraId` so `applyEndAttributes` / `setStatus` / `recordException` / `end()` all act on the same instance — no `ReadableSpan` is ever manually constructed here, so the `makeSpanOtelV2Compatible` requirement (next bullet) does not apply.
- Any code that manually constructs a `ReadableSpan` (e.g. framework-exporter bridges that synthesize spans from non-OTel sources) MUST call `makeSpanOtelV2Compatible` from `../../tracing/compat` on the result — without it, setting only v2 fields (`parentSpanContext`, `instrumentationScope`) breaks users on OTel SDK v1 (parent-child links and scope info are dropped, traces render flat).
- **Mastra does NOT propagate OTel context into its event bus.** Mastra tracks its own trace ids and fires `ObservabilityExporter` handlers synchronously inside the caller's async context, but never creates OTel spans. So a user's outer `observe()` span is invisible to Mastra internals. `MastraExporter` solves this in `getOrCreateTraceState` (first-event time per Mastra trace) by resolving the outer span from two sources, in order: (1) `LaminarContextManager.getContext()` — the AsyncLocalStorage that `Laminar.startActiveSpan()` writes onto (its spans never touch OTel's standard context, so step 2 alone wouldn't see them); (2) `trace.getActiveSpan()` — the standard OTel active span (set by `observe()` via `context.with(...)` and any other OTel-aware instrumentation). Subsequent Mastra spans' trace id / root parent span id are rewritten onto that captured context. Controlled by the `linkToActiveContext` option (default true); descendants inherit the rewritten trace id because every Mastra descendant's `parentSpanId` points at another Mastra span id that also gets rewritten onto the same OTel trace.
- **Laminar's UI nests spans by `lmnr.span.ids_path`, NOT by OTel parentSpanId.** Sharing the OTel trace id with `observe()` is not enough to make the Mastra subtree render under the outer span. The exporter also captures the outer span's `lmnr.span.path` and `lmnr.span.ids_path` attributes (set by `LaminarSpanProcessor.onStart`) at first-event time and prepends them onto every Mastra span's path arrays. Only Mastra roots need explicit prepending — descendants inherit from their Mastra parent's already-prefixed path stored in `TraceState.spanPathById` / `spanIdsPathById`.
- **Thinking tokens are captured from MODEL_CHUNK children.** Mastra drops reasoning from `MODEL_STEP.output`/`attributes` (see `#endStepSpan` in `@mastra/observability/dist/index.js`); `MODEL_GENERATION.output` only carries a flat cross-step `reasoningText` string (concatenated via `#bufferedReasoning` with no step boundaries), so neither is usable for per-step reasoning. The only source that preserves step-level boundaries is the `MODEL_CHUNK` spans with `attributes.chunkType: "reasoning"` whose `parentSpanId` points at the owning MODEL_STEP and whose `output.text` holds the reasoning delta accumulated by Mastra's own chunk-span transform. Chunks end BEFORE the parent step ends, so `captureReasoningChunk` accumulates per-step text into `GenerationState.reasoningTextByStepIndex` and the step's own `span_ended` handler can then emit `gen_ai.output.messages` (OTel GenAI semconv with `{type: "thinking", content}` parts) — no span buffering needed. Laminar's backend preserves `gen_ai.output.messages` verbatim on `self.output` and the frontend GenAI parser maps `thinking` → ModelMessage `reasoning` (rendered with a "Thinking" label). When a step produces multiple reasoning-start/end cycles, concatenate the chunk texts in arrival order to mirror Mastra's `#bufferedReasoning` behavior. Reasoning is intentionally NOT echoed as a `{type: "reasoning", text}` part into the next step's `ai.prompt.messages` — across providers the plain reasoning text is not re-sent on subsequent calls (OpenAI tracks it server-side via `previous_response_id`, Anthropic preserves a signed `thinking` block, Gemini manages it internally), so injecting it would misrepresent what the LLM actually received.

## Mastra Integration — Host App Requirements

When adding/modifying integration tests for Mastra:

- Mastra `v1.28+` exposes observability as an `Observability` instance (from `@mastra/observability`), not a plain config map. Pass it as `new Mastra({ observability: new Observability({ default: { enabled: false }, configs: { laminar: { serviceName, exporters: [exporter] } } }) })`.
- Use `await observability.shutdown()` to flush — there is no `.flush()` method on `Observability`.
- AI SDK v6 (Mastra 1.28's dep) changes two things: tool `execute` is `(inputData) => ...` (not `({ context })`), and `maxSteps` is removed — use `stopWhen: ({ steps }) => (steps?.length ?? 0) >= N`.

## Coding Style

- Prefer arrow functions: `const foo = async (...) => { ... }` over named `function foo()`.
- Rely on pre-commit hooks; don't run project-wide type-checks manually.
- Use `errorMessage(err)` from `@lmnr-ai/types` for stringifying unknown error values. `@lmnr-ai/types/utils.ts` is the canonical home for small shared runtime helpers that all packages can depend on (it already has a runtime build, not just types).

## Formatting / Lint

- No project-wide `prettier` binary is installed; "format" is enforced through eslint (`@stylistic/*` rules). Use `pnpm -r lint:fix` (or `pnpm --filter <pkg> lint:fix`) instead of `prettier --write`.
- Max line length is 100 chars (`@stylistic/max-len`). Long destructured `import` lines will fail lint — break them across multiple lines.
