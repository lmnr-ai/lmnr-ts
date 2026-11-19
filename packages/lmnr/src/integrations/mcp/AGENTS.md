# MCP server observability (`wrapMcpServer`) — LAM-2563

`wrapMcpServer(server, options)` turns every `tools/call`, `prompts/get` and `resources/read` request an MCP server handles into a ROOT `SERVER` span, one trace per user turn. The span contract (names, attribute keys, `error.type` strings, redaction vectors, turn rules) is shared with the Python SDK and app-server's own MCP server, and the platform's MCP dashboard queries those exact strings. Change them in all three together.

Files: `index.ts` (`wrapMcpServer`, the handler-table hook), `span.ts` (attributes, trace-id choice, running a handler in its span), `outcome.ts` (result / error → `error.type`, ending the span), `request.ts` (what a request carries: session, client, protocol, headers), `context-field.ts`, `options.ts`, `shared.ts` (types, process-wide state, `resetMcpState`), `attributes.ts` (keys, `error.type` values, the verbatim `context` description), `redact.ts`, `turns.ts` (turn tracker, turn-id hash, `traceparent` parsing).

## Behaviour that must not change

Each was a decision, pinned by `test/mcp.test.ts` / `test/mcp-turns.test.ts` / `test/mcp-app-provider.test.ts`; a cleanup must keep all of them.

- One ROOT SERVER span per `tools/call` / `prompts/get` / `resources/read`, including SDK-folded failures; none for `initialize`, `ping`, listing. Name `{method} {target}`.
- The attribute keys, `error.type` values (`tool_error`, `-32602` incl. folded texts, JSON-RPC codes, else the thrown class) and `rpc.response.status_code` only for real JSON-RPC errors.
- Trace id order (turn id → session tracker → `traceparent` → random), `traceparent` always a link, a call releases only the `Turn` it joined, gap clamped to 25 s, forced ids also inside an app-owned provider.
- `context`: injected into `tools/list` copies, stripped before validation, kept in the recorded arguments, tools with their own `context` untouched (registry first, then `tools/list` per instance and process-wide).
- Redaction always; `recordPayloads: false` keeps names, counts, errors only. Instrumentation never changes what the server answers.

## Mechanisms removed in the cleanup (don't re-add without a real failure)

- `McpServer.executeToolHandler` hook + per-request record: it only turned `tool_error` into the class name of an exception McpServer had already folded into `isError`. Folded exceptions are `tool_error` now, as in the Python SDK.
- Per-session `clientInfo` / protocol-version maps: stateful Streamable HTTP pins a session to one server instance (the instance's `getClientVersion()` / `initialize` result), and stateless servers have no session to key on. 2026-07-28 requests carry both in `ctx.mcpReq.envelope`.
- `network.transport` from the transport's class name (`Stdio` → `pipe`): only an HTTP request now sets `tcp` / `http`, as in Python.
- Reading 2.x's private `_negotiatedProtocolVersion`, the `extra._meta` / `extra.mcpReq._meta` / `extra.requestId` fallbacks (both majors hand the handler a request with `id` and `params._meta`), and the double-wrap marker on handlers (neither SDK re-sets a handler it read from `_requestHandlers`; `wrapMcpServer` hooks a table once).

## How the SDKs are hooked (no runtime dependency on them)

- `@modelcontextprotocol/sdk` and `@modelcontextprotocol/server` are **devDependencies only**: everything is duck-typed. Supported: SDK 1.x `McpServer` and `Server`, and the 2.x split package `@modelcontextprotocol/server` (`McpServer` and `Server`; 2.4.0 at the time of writing). Detection: an object whose `_requestHandlers` is a `Map` and that has `setRequestHandler` is a low-level server; an object with such a `.server` plus `_registeredTools` is an `McpServer`.
- **The hook is the low-level server's `_requestHandlers` Map**, the same in 1.x (`Protocol`) and 2.x. `set` is overridden on that Map instance and existing entries are re-wrapped, so handlers registered later (McpServer registers `tools/*` lazily, on the first `registerTool`) are wrapped too. Our wrapper is the OUTERMOST layer: it sees the raw request (1.x: the JSON-RPC message; 2.x: a copy with the 2026 envelope keys lifted out of `_meta`, `traceparent` / `aiInvocation` stay) BEFORE the SDK's own schema parse and McpServer's argument validation, and it sees the result or the thrown error.
  - `extra` (1.x) / `ctx` (2.x) carry the session: `extra.sessionId` / `ctx.sessionId`; HTTP headers: 1.x `extra.requestInfo.headers` (plain object), 2.x `ctx.http.req.headers` (`Headers`).
  - `initialize` is wrapped only to remember the negotiated `protocolVersion` on the instance (1.x does not store it anywhere else); client info comes from `getClientVersion()`. 2.x modern-era (2026-07-28) requests carry both in `ctx.mcpReq.envelope`.
  - Requests the SDK rejects before any handler runs (e.g. `tools/call` on a server without a tools capability → `-32601`) produce no span.
- **Error shapes differ by version.** 1.x McpServer folds EVERY error of `tools/call` (unknown tool, validation, handler exception) into an `isError` result whose text starts `MCP error -32602: ...`. 2.x throws a real JSON-RPC `-32602` for an unknown/disabled tool and folds validation (`Input validation error: ...`) and handler exceptions. `isInvalidParamsText` maps the folded texts to `-32602`; `rpc.response.status_code` is set only for real JSON-RPC errors (a thrown error without a numeric `code` is answered `-32603` by both SDKs).
- Handler exceptions McpServer folds into `isError` are `tool_error`; an exception that reaches our wrapper (low-level servers, prompts, resources) is its numeric `code`, else its class name.
- Wrapping twice is a no-op: the low-level server is marked with `Symbol.for("lmnr.mcp.wrapped")` (holding its state). Wrapping an `McpServer` whose `.server` was wrapped first still records the `McpServer` for its tool registry.
- Every instrumentation step is try/catch-guarded and falls back to calling the original handler; results and errors pass through untouched (only the `context` argument is removed from the request copy given to the inner handler).

## The `context` field

- Injected into every tool's `inputSchema.properties` in the `tools/list` RESULT (copies: 2.x caches the JSON schemas it lists), never into `required`. Off when `context: false` or `recordPayloads: false`.
- Stripped on a `tools/call` copy of the request before the inner handler, so `.strict()` / `additionalProperties: false` schemas still validate. The recorded `gen_ai.tool.call.arguments` keeps it.
- **"Tool declares its own `context`" is decided per call, not from `tools/list`**, because stateless HTTP servers often serve `tools/list` and `tools/call` from different instances. McpServer: 2.x `toolInputSchemaJson(name)` (JSON Schema); otherwise the registered Zod schema's `shape` (`schema.shape` / `_zod.def.shape` / `_def.shape()`). Low-level `Server`: only what a `tools/list` served in this process showed (per instance, then process-wide by tool name); **unknown means "not declared", so the field is stripped**. Known gap: a low-level server whose own tool has a `context` argument, called in a process that never served `tools/list`, loses that argument.
- `lmnr.mcp.context` = the stripped value (trimmed, 1000 chars) or `_meta["io.modelcontextprotocol/aiInvocation"].userIntent`. The `userIntent` fallback applies to every traced method and also when `context: false` (it costs the model nothing).

## Turns and forced trace ids

- Order: client `turnId` (sha256 of `"{sessionId or ''}\n{turnId}"`, first 32 hex) → in-process `TurnTracker` when the request has a session → client `traceparent` trace id → random. With a session, the tracker's current turn wins; when the session has NO current turn (a new turn), the turn starts with the request's `traceparent` trace id if it carries a valid one (random otherwise), and later calls in the gap join it, whatever `traceparent` they carry. Same as the Rust server and the docs. A valid `traceparent` is ALWAYS added as a span LINK, never as a parent. Session: transport session id → `mcp-session-id` header → `_meta["openai/session"]`.
- **Why the tracker beats `traceparent` when there is a session** (contract change from live testing): MCP clients with their own OTel send a fresh trace id per call, which split every call into its own trace, and clients that keep one trace for the whole session would merge many turns into one. The gap tracker is never that wrong. Without a session, the `traceparent` trace id still applies. Pinned by `with a session, a new turn starts with its traceparent and later calls join it`.
- The tracker and the own-context registry are MODULE-level (`shared.ts`), because Streamable HTTP servers usually create one server instance per session (or per request). The registry is capped at 10k entries. A new turn forces at most the `traceparent` id, and the tracker stores whatever trace id the span actually got, so it degrades gracefully when forcing is impossible. An in-flight mark older than 10 minutes stops pinning a session (a handler that never settles).
- `begin` / `start` return the `Turn` object and the call releases exactly that object in `end`, never "whatever turn the session holds now": a call that hung past the 10-minute in-flight limit (or a new-turn call whose span got no valid trace id and registered nothing) would otherwise decrement a later turn's `inFlight` and split its overlapping calls into a new trace. Pinned by `test/mcp-turns.test.ts`.
- `turnGapMs` is clamped to 25 s (must stay under the 30 s Signals settle window).
- Forcing a ROOT span's trace id: `withForcedTraceId` + `LaminarIdGenerator` in `opentelemetry-lib/tracing/id-generator.ts` (see the tracing AGENTS.md). Inside an app-owned provider (Laminar only as a `LaminarSpanProcessor`, `getTracer()` falls back to the global provider), `enableForcedTraceIds` wraps that provider's generator in place. Pinned by `test/mcp-app-provider.test.ts` (its own process: it registers a global provider).

## Payloads

- `recordPayloads: false` drops `gen_ai.tool.call.*`, `lmnr.span.input/output`, `lmnr.mcp.context`, `mcp.resource.uri`, and replaces exception / status messages with fixed text. Names, `error.type`, status codes, client and session stay.
- Tool spans record only `gen_ai.tool.call.arguments` / `.result` (app-server lifts them into input/output for TOOL spans); `prompts/get` / `resources/read` record `lmnr.span.input` (params without `_meta`) and `lmnr.span.output`. All go through `redact` then `toJson` + `truncateSpanPayload`.
- Redaction: normalized key (lowercase, non-alphanumerics removed) contains one of the secret substrings, ends with `token`, or equals `auth|pwd|otp|bearer|jwt`; plus customer `redactKeys` (exact, normalized). Test vectors are in `test/mcp.test.ts` (`MCP redaction`) and must match the Python SDK's.

## Tests

`test/mcp.test.ts` drives real 1.x and 2.x clients against wrapped servers over `InMemoryTransport` (setting `serverTransport.sessionId` simulates a session) and 1.x Streamable HTTP over a local `node:http` server, with `InMemorySpanExporter`. `resetMcpState()` clears the module-level maps between tests.
