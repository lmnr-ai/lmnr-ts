# Cohere instrumentation — LAM-2407

- This is a port of the Python SDK's `opentelemetry_lib/opentelemetry/instrumentation/cohere`. It replaces `@traceloop/instrumentation-cohere`, and that dependency is gone. Span names are `cohere.chat` / `cohere.completion` / `cohere.rerank` / `cohere.embed`, `gen_ai.system="cohere"`, and messages use the GenAI `{role, parts}` shape. Usage prefers `tokens` over `billedUnits`, and v2 `usage.cachedTokens` becomes `gen_ai.usage.cache_read_input_tokens`. Embed spans carry no output messages. `gen_ai.tool.definitions` sits behind the `traceContent` gate. `generateStream` is not instrumented, and OpenLLMetry didn't instrument it either.
- **Patch targets are two prototypes:**
  - v1 is `CohereClient.prototype`. Methods actually live on the generated `Client.CohereClient` parent, and `definingPrototype` walks up to it.
  - v2 is the `V2Client` prototype. **`V2Client` is not exported** (the package `exports` only has `.` and `./aws`), so `v2ClientPrototype` reads it off a throwaway `new CohereClient({token}).v2` (falling back to `new CohereClientV2().clientV2`). Constructing a client does no I/O.
  - `client.v2.chat(...)` and `CohereClientV2#chat` both dispatch through that prototype.
- **Known gap: `CohereClientV2` instances created BEFORE `initialize()` are not traced.** Its constructor copies bound methods onto the instance (`this.chat = this.clientV2.chat.bind(...)`). `CohereClient` and `client.v2` use prototype dispatch, so they are traced whenever they were created. `CohereClientV2#generate/generateStream/classify` are v1 prototype methods bound to the V2Client; `generate` therefore produces a `cohere.completion` span tagged as v1, which is correct.
- **Methods return `HttpResponsePromise`** (a Promise subclass with `withRawResponse()`). The wrapper keeps it one:
  - The original call is boxed in `Laminar.withSpan`, the same as Anthropic.
  - The result is rebuilt with `result.constructor.fromPromise(result.withRawResponse().then(raw => ({...raw, data: succeed(raw.data)}), rethrow))`.
  - A plain `.then` would drop `withRawResponse()`.
- **Streams:**
  - v1 `chatStream` is NDJSON with an `eventType` discriminator. The terminal `stream-end` event carries the full `response`, so the accumulator just returns it.
  - v2 is SSE (`data: {...}` lines, ending in `data: [DONE]`) with a `type` discriminator. `createV2ChatStreamAccumulator` rebuilds the message from `content-delta` / `tool-plan-delta` / `tool-call-*` deltas plus `message-end`'s `finishReason` and `usage`.
  - Only `stream[Symbol.asyncIterator]` is replaced. The span ends on completion, on error, or when the caller breaks early (with the partial output).
- **All parsed fields are camelCase** (`maxTokens`, `chatHistory`, `toolCalls`, `responseId`, `finishReason`, `billedUnits.inputTokens`, `relevanceScore`, `imageUrl.url`), because the SDK serializers convert from the snake_case wire format. Python reads snake_case, so do not copy its field names verbatim.
- Tests (`test/cohere.test.ts`) need no cassettes. They pass a stub `fetch` plus `maxRetries: 0` to the client constructor, and route by URL path. Wire bodies are snake_case. Streams are sent as NDJSON lines (v1) or as SSE with `content-type: text/event-stream` (v2). The SDK validates requests before sending, so v2 tools need `function.parameters` or the call throws before `fetch` runs.
- Not ported yet: the Python rollout/debugger caching wrappers. The user scoped LAM-2407 to the basics.
