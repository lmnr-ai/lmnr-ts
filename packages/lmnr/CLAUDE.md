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
- `LaminarSpan.end()` only calls `popContext()` once (for the activated-span push). Do NOT push additional context frames elsewhere in `_startSpan` without a matching pop — `popContext`'s filter drops _already-ended_ spans by spanId, but a leaked wrapper of a still-live parent span (e.g. `trace.wrapSpanContext(...)` built from `parentSpanContext`) looks "valid" and stays on the stack, growing it unboundedly across repeated start/end pairs. The `parentSpanContext` path is resolved purely via `trace.setSpan(entityContext, ...)` + passing `entityContext` to `getTracer().startSpan(..., entityContext)` — no push needed.

# OpenTelemetry Instrumentations

- Instrumentations live under `src/opentelemetry-lib/instrumentation/<name>/` and are registered in `src/opentelemetry-lib/tracing/instrumentations.ts` (both auto-registration path and the `manuallyInitInstrumentations` path — keep the two in sync).
- For manual instrumentation, expose an option key on `InitializeOptions.instrumentModules` and wire it through `manuallyInitInstrumentations`.
- `TracingProcessor` from `@openai/agents` requires the interface methods return `Promise`. Most of our methods have no `await` — add a file-level `/* eslint-disable @typescript-eslint/require-await */` around the class rather than sprinkling `await Promise.resolve()`.
- `@openai/agents` re-exports types and classes from `@openai/agents-core` and `@openai/agents-openai`. Import from `@openai/agents` to avoid adding `-core`/`-openai` as direct dependencies.
- When patching prototypes registered via multiple `InstrumentationNodeModuleDefinition` entries that resolve to the same class (e.g. `@openai/agents` and `@openai/agents-openai` both expose `OpenAIResponsesModel.prototype`), guard `_wrap` with a `WeakSet` of already-wrapped prototypes — `shimmer` happily double-wraps and will run your wrapper logic twice per call.
- `AsyncLocalStorage.run(value, fn)` restores the previous context as soon as `fn` returns — for async iterables/streams, wrap **each** `next()`/`return()`/`throw()` call in its own `.run()` so the context is visible across yields, not just at iterator creation.

# Cursor Agent SDK (`@cursor/sdk`)

- LLM calls are executed **server-side at Cursor** — the client SDK only receives an `SDKMessage` stream over the `Run` async iterator. There is no local HTTP/fetch to intercept, and Cursor does not publish a proxy-endpoint knob. The instrumentation therefore patches `Agent.create/resume/prompt` (the only pre-run entrypoints) and wraps the returned `SDKAgent.send(...)` so that each `Run` gets its own parent LLM span, with tool / subagent child spans synthesized from the message stream.
- `InteractionUpdate.type === "turn-ended"` is the **only** source of token usage. SDKMessages (`assistant`, `thinking`, `tool_call`, etc.) carry the semantic content; usage never appears in the message stream. Capture it via the `onDelta` callback forwarded through `send(message, opts)`.
- The **Task subagent** surfaces as a normal `tool_call` message with `name: "task"`. No special-case branching needed in the instrumentation — the standard child-TOOL-span handler captures its input (prompt/description/subagentType/model) and its output (conversationSteps array with thinking, assistantMessage, nested toolCall entries) verbatim.
- Child tool spans are parented via `parentSpanContext: JSON.stringify(state.parentLaminar.getLaminarSpanContext())` so the LLM parent's `lmnr.span.ids_path` propagates — **do not** start them with `startActiveSpan` / ALS, because tool calls can overlap and complete out of order within a single run.
- End the parent span from whichever control path the caller exercises: `run.stream()` drain, `run.wait()` resolve, or `run.cancel()`. Use a single `endParent()` helper guarded by a `parentEnded` flag — otherwise whichever path fires second will no-op but can leave child TOOL spans orphaned if the ordering differs.
- In patched async generators that wrap a stream, call `endParent()` in a `finally` block — NOT only in the `catch`. A successful `for await` drain exits via normal return, bypassing any catch-only cleanup, and leaves the parent span unended. Mirror `google-genai/utils.ts` (`try { for await ... } catch { record } finally { span.end() }`).

# Laminar.initialize — local dev gotcha

- Default `grpcPort` is `8443`, but the self-hosted app-server (`/repos/lmnr/app-server`) exposes gRPC on `:8001`. For verification scripts hitting the local stack, pass `{ httpPort: 8000, forceHttp: true }` (or `{ grpcPort: 8001 }`) — otherwise the OTLP exporter fails with `ECONNREFUSED :8443`.
- `node --env-file=<path>` does **not** override already-set `process.env` vars. If the sandbox shell has an outer `LMNR_PROJECT_API_KEY` pointing at a different project, the `.env` value is silently ignored and exports return 401. Run with `env -u LMNR_PROJECT_API_KEY -u LMNR_BASE_URL node --env-file=...` to force the .env values to win.

# Agents SDK — TS vs Python parity

- TS `ModelRequest` puts `systemInstructions` as a top-level field (not inside a kwargs bag like Python). The Python wrapper extracts it from `kwargs`; the TS wrapper reads `request.systemInstructions`.
- TS agents span_data uses private fields `_response` and `_input` (not `response` / `input`). The Python handlers read the public field names — when porting, check both.
- Manual instrumentation in tests: call `setTracingDisabled(false)` + `setTraceProcessors([])` first to clear any globally registered processors, then pass a `manuallyInstrument({ addTraceProcessor, OpenAIResponsesModel, OpenAIChatCompletionsModel })` shim that forwards to `setTraceProcessors([p])`.
- When mapping agents SDK `TracingProcessor` callbacks to Laminar spans, resolve parent spans via the agents SDK's `span.parentId` (looking up our `state.spans` map) and pass the result as `parentSpanContext`. Do NOT rely on `LaminarContextManager.getContext()` / `startActiveSpan({ global: true })` for child spans — the global stack is process-wide, so concurrent agent runs would cross-contaminate parent chains. Start from `ROOT_CONTEXT` to keep traces isolated.
- Processor-created spans use `Laminar.startSpan` (not `startActiveSpan`) so they skip Laminar's built-in activation path (which pops LIFO on `end()` and would corrupt the stack when agent spans end out of order). But to keep nested Laminar instrumentation (google-genai, etc.) running inside tool / agent callbacks parented to the agents span, the processor manually pushes the activation context onto the Laminar ALS stack on `onSpanStart` and removes it by reference (not LIFO) on `onSpanEnd` via `LaminarContextManager.removeContext(ctx)`. Reference-based removal is what makes out-of-order ends safe.
