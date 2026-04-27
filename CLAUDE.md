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
  - `MODEL_CHUNK` → dropped entirely (streaming noise).
- **Mastra `MODEL_STEP.input` is lossy across steps** — after step 0, tool-result messages show up as empty user messages. We reconstruct the real per-step message history by tracking the parent `MODEL_GENERATION` baseMessages + accumulating per-step turns (assistant tool-call + tool tool-result) from child `TOOL_CALL` spans.
- **`TOOL_CALL` children end BEFORE their parent `MODEL_STEP` ends.** Pair them at *step-end time* against the declared `output.toolCalls` by arrival order — do NOT try to pair them when the tool span ends (declared toolCalls are not available yet).
- Tool-result messages are emitted as `{role:"tool", tool_call_id, content:[{type:"tool-result", toolCallId, toolName, output}]}` — this matches what Laminar's backend (`app-server/src/language_model/chat_message.rs`) expects via `InstrumentationChatMessageAISDKToolCall`/`ToolResult`.
- Exporter internals use narrow local interfaces instead of importing `@mastra/core` types, so there is no peer dep on Mastra.
- Any code that manually constructs a `ReadableSpan` (e.g. framework-exporter bridges that synthesize spans from non-OTel sources) MUST call `makeSpanOtelV2Compatible` from `../../tracing/compat` on the result — without it, setting only v2 fields (`parentSpanContext`, `instrumentationScope`) breaks users on OTel SDK v1 (parent-child links and scope info are dropped, traces render flat).
- **Mastra does NOT propagate OTel context into its event bus.** Mastra tracks its own trace ids and fires `ObservabilityExporter` handlers synchronously inside the caller's async context, but never creates OTel spans. So a user's outer `observe()` span is invisible to Mastra internals. `MastraExporter` solves this by reading `trace.getActiveSpan()` synchronously inside `getOrCreateTraceState` (first-event time per Mastra trace) and rewriting subsequent spans' trace id / root parent span id onto that OTel context. Controlled by the `linkToActiveContext` option (default true); descendants inherit the rewritten trace id because every Mastra descendant's `parentSpanId` points at another Mastra span id that also gets rewritten onto the same OTel trace.
- **Laminar's UI nests spans by `lmnr.span.ids_path`, NOT by OTel parentSpanId.** Sharing the OTel trace id with `observe()` is not enough to make the Mastra subtree render under the outer span. The exporter also captures the outer span's `lmnr.span.path` and `lmnr.span.ids_path` attributes (set by `LaminarSpanProcessor.onStart`) at first-event time and prepends them onto every Mastra span's path arrays. Only Mastra roots need explicit prepending — descendants inherit from their Mastra parent's already-prefixed path stored in `TraceState.spanPathById` / `spanIdsPathById`.
- **Thinking tokens live only on the parent `MODEL_GENERATION.output.steps[i].reasoningText`** — Mastra drops them from `MODEL_STEP.output`/`attributes` entirely (see `#endStepSpan` in `@mastra/observability/dist/index.js`, which ends the step with `output: otherOutput` = payload output minus usage/reasoning). The generation's aggregated `output.steps[]` is assembled from the stream's `#bufferedSteps` AFTER all step spans have already ended. So the exporter BUFFERS `MODEL_STEP` spans (`GenerationState.pendingStepSpans`) and holds them back from `processor.onEnd` until the parent MODEL_GENERATION's `span_ended` arrives. At that point we index `reasoningText` by step index and flush the buffered step spans, emitting `gen_ai.output.messages` (OTel GenAI semconv with `{type: "thinking", content}` parts) when a step has reasoning — Laminar's backend preserves `gen_ai.output.messages` on `self.output` and the frontend GenAI parser maps `thinking` → ModelMessage `reasoning` parts (rendered with a "Thinking" label). We also retroactively inject a `{type: "reasoning", text}` content part into the cached assistant turn in `turnsByStepIndex` so follow-up steps' `ai.prompt.messages` show prior thinking. Cleanup of `generationIdByStepId`/`stepIndexBySpanId` for step spans must live inside the generation's `finally`, not the step's own, because the step's finally would run before the deferred flush.

## Mastra Integration — Host App Requirements

When adding/modifying integration tests for Mastra:

- Mastra `v1.28+` exposes observability as an `Observability` instance (from `@mastra/observability`), not a plain config map. Pass it as `new Mastra({ observability: new Observability({ default: { enabled: false }, configs: { laminar: { serviceName, exporters: [exporter] } } }) })`.
- Use `await observability.shutdown()` to flush — there is no `.flush()` method on `Observability`.
- AI SDK v6 (Mastra 1.28's dep) changes two things: tool `execute` is `(inputData) => ...` (not `({ context })`), and `maxSteps` is removed — use `stopWhen: ({ steps }) => (steps?.length ?? 0) >= N`.

## Local End-to-End Testing Against Laminar

The staging sandbox project for this workspace is `0cce3ee3-d6bb-437d-a2fa-bbfd72a935e2`. The API key in env `LMNR_LOCAL_PROJECT_API_KEY` targets it. Trace URL: `http://localhost:3000/project/0cce3ee3-d6bb-437d-a2fa-bbfd72a935e2/traces/<traceId>`. For local login, `FORCE_EMAIL_AUTH=true` in the frontend's `.env.local` accepts any email — the sandbox owner is `agent@lmnr.ai`.

## Coding Style

- Prefer arrow functions: `const foo = async (...) => { ... }` over named `function foo()`.
- Rely on pre-commit hooks; don't run project-wide type-checks manually.

## Formatting

- NEVER run `pnpm format:write` or `prettier --write .`.
- Only format files you changed: `prettier --write <file1> <file2>`.
