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

## Debug mode (`packages/lmnr/src/debug/`)

- `src/debug/config.ts` is a **cross-language parity surface** with the Python SDK `src/lmnr/sdk/debug/config.py` — keep the two line-comparable.
- **The debugger pre-run note is set with `LMNR_DEBUG_RUN_NOTES_FILE` (path to a raw-markdown file) or `LMNR_DEBUG_RUN_NOTES` (inline raw markdown), not by hand-stringifying JSON into `LMNR_TRACE_METADATA`.** `resolveDebugRunNote()` reads them ONLY when `LMNR_DEBUG` is truthy; the file wins over inline, and a missing/unreadable file logs a warning and returns `null` (never throws — a bad note path must not block init). `laminar.ts` parses `LMNR_TRACE_METADATA` as before, then overrides just the `rollout.note` key (`ROLLOUT_NOTE_KEY`) with the resolved note before merging the explicit `metadata` arg on top. The note is NOT propagated downstream via `LaminarSpanContext` (origin-only). Mirror `resolveDebugRunNote` / `ROLLOUT_NOTE_KEY` in the Python `config.py`. Tested in `test/debug/config.test.ts`.

## Temporal Instrumentation (`packages/lmnr/src/opentelemetry-lib/instrumentation/temporal/`)

- Temporal workflow functions run in a **V8 deterministic sandbox** — no `crypto.randomUUID()`, no real timestamps. `observe()` / `Laminar.startActiveSpan()` cannot be called inside workflow functions (they call `crypto.randomUUID` internally). Only the client side (workflow-start calls) and worker side (activity functions) are safe to instrument.
- Context is propagated via Temporal headers (`Record<string, Payload>`). Two headers are written: `laminar-span-context` (full Laminar JSON — preferred) and `traceparent` (W3C, for interop). Both are encoded as `json/plain` Temporal Payloads without importing `@temporalio/common` — we encode as `{ metadata: { encoding: Uint8Array("json/plain") }, data: Uint8Array(JSON.stringify(value)) }`.
- `WorkflowClientInterceptor` reads the active span via `trace.getSpan(LaminarContextManager.getContext())` (Laminar's ALS first) and checks `instanceof LaminarSpan` to call `getLaminarSpanContext()`. Falls back to OTel span context for `traceparent`-only propagation.
- `ActivityInboundInterceptor` restores context via `restoreContextFromHeaders` which calls `pushLaminarContext`. That function calls `processor.setParentPathInfo` so descendant spans inherit the correct `lmnr.span.path`, then pushes the restored context onto Laminar's ALS via `LaminarContextManager.pushContext`, and RETURNS the enriched OTel `Context` it built. `restoreContextFromHeaders` returns `{ laminarCtx, otelContext } | undefined` (was a bare `LaminarSpanContext | undefined`).
- **When `createActivitySpan` is `false` the interceptor MUST still activate the restored OTel context for the activity body** (`contextApi.with(restored.otelContext, () => next(input))`). Pushing only onto Laminar's ALS makes `observe()` / `Laminar.startActiveSpan()` nest correctly (they read the ALS), but OTel-aware auto-instrumentations (OpenAI, etc.) read the STANDARD OTel context (`context.active()`) — which is still `ROOT_CONTEXT` inside `runWithIsolatedContext([ROOT_CONTEXT], ...)` — so without the `contextApi.with` they start detached root traces. The `createActivitySpan: true` path doesn't need this because `Laminar.withSpan` activates both contexts. Regression covered by the two `nests … when createActivitySpan is false` cases in `test/temporal.test.ts`.
- `patchTemporalWorker` monkey-patches `Worker.create` static method; `patchTemporalClient` mutates `clientModule.Client` in place so any code that reads `Client` from the same module object after `initialize()` gets the patched subclass — auto-patching is wired in `manuallyInitInstrumentations` when `instrumentModules.temporal` is present.
- The interface uses `client` (the full `@temporalio/client` module, `import * as temporalClient`) not a bare `Client` class — mutating the module property ensures the user's `temporalClient.Client` binding is patched after `initialize()`. A bare destructured `import { Client }` cannot be patched this way; those users should use Option A (explicit interceptor).
- **`Worker.create({ workflowBundle })` ignores `interceptors.workflowModules`** (the bundle is compiled before `Worker.create` runs). `patchTemporalWorker` therefore skips injecting the workflow interceptor module when `workflowBundle` is set and warns once — without that, the injection is a silent no-op and workflow-side outbound header propagation (start trace → scheduled activities / child workflows) never runs. Pre-bundled workers MUST register `@lmnr-ai/lmnr/temporal-workflow-interceptors` via `bundleWorkflowCode({ workflowInterceptorModules: [...] })` at bundle time.
- **Activity span recording is gated by three independent options** on `LaminarTemporalInterceptorOptions` (all default `true`): `createActivitySpan` (wrap the activity at all), `recordActivityArgs` (pass `input.args` as the span input), `recordActivityOutput` (call `setOutput(res)`). `recordActivityArgs`/`recordActivityOutput` are ignored when `createActivitySpan` is `false`. They thread through `instrumentModules.temporal.{recordActivityArgs,recordActivityOutput}`.
- **The client-side workflow lifecycle span is created by patching `WorkflowClient.prototype` (`workflow-span.ts`), NOT by the `start` interceptor.** `WorkflowClientInterceptor.start` resolves at the start RPC, not at workflow completion, so it cannot span start→result. `patchWorkflowClient` wraps `start`/`signalWithStart` (start the span, keep it open, hand the returned handle to `wrapHandle`) and `execute` (span is local — start RPC + result in one call). The span is kept active across the start RPC via `Laminar.withSpan(span, fn, /*endOnExit*/ false)` so the still-active span is what `WorkflowClientInterceptor.start` injects into headers — this is what makes the worker-side workflow + activities nest under it. `patchWorkflowClient` is called from inside `patchTemporalClient` (the high-level `Client` builds its `workflow` sub-client from the same `WorkflowClient` class, so prototype-patching covers both `new Client()` and direct `new WorkflowClient()`).
- **`wrapHandle` ends the workflow span on the FIRST terminal call** (`result()` resolve/reject, `cancel()`, or `terminate()`) guarded by a `closed` flag, so the canonical `cancel()` → `result()` pattern ends the span exactly once. `cancel`/`terminate` additionally emit a dedicated child span (`temporal.workflow.cancel` / `temporal.workflow.terminate`) parented via `Laminar.serializeLaminarSpanContext(span)`. Output is recorded only when `result()` resolves.
