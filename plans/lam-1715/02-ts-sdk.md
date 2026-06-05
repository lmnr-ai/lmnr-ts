# LAM-1715 — Debugger Cache v2: TS SDK Component Plan

> **Status:** design / not yet implemented.
> **Read `00-shared-spec.md` first.** This file only describes how the TS SDK
> (`@lmnr-ai/lmnr` + `@lmnr-ai/client`) fulfils the shared contract. Anything
> about the wire format, the three outcomes, the input hash, or what app-server
> does lives in the shared spec — do not re-derive it here.
> Branch: `feat/lam-1715-debugger-cache-v2` (off `main`).

---

## 0. Orientation: what the TS SDK does today (v1)

The v1 replay path is entirely in-process:

- `src/debug/index.ts` — `DebugRuntime`, builds an in-memory `ReplayCache`
  asynchronously after `initialize()` returns, holds per-path occurrence
  counters (`_counters`), exposes `getCached(spanPath)` and `awaitCacheReady()`.
- `src/debug/replay-cache.ts` — the in-memory cache (`ReplayCache`,
  `payloads[:cacheUntil]`, `getCached(path, occurrence)`).
- `src/debug/source-trace.ts` — two-phase ClickHouse fetch over
  `LaminarClient.sql.query` (`fetchSpineMetadata`, `fetchSpinePayloads`).
- `src/debug/spine.ts` — spine detection, `hasOverlap`, `resolveCacheUntilSpanId`.
- `src/debug/config.ts` — `buildDebugConfig`, `_parseCacheUntil` (count OR span
  id), `loadLastRun`, the truthy set.
- `src/debug/replay.ts` — generic helpers `replayEnabled`, `spanPathFromSpan`,
  `cachedPayloadFor`, `markSpanCached`.
- `src/debug/pointer.ts` — run pointer (console line + `.lmnr/last-run.json`).
- The only replay **consumer** is the AI SDK wrapper:
  `src/opentelemetry-lib/instrumentation/aisdk/base-language-model.ts`
  (`doGenerateOrStreamWithCaching` → `cachedPayloadFor(spanPath)` →
  `markSpanCached` + reconstruct).

v2 removes the spine/occurrence/in-memory-cache machinery and replaces the
per-call lookup with one HTTP round-trip to app-server keyed by an **input hash**.

---

## 1. Removed / kept / added (file-level)

### Removed
- `src/debug/replay-cache.ts` — delete. No in-process cache anymore.
- `src/debug/source-trace.ts` — delete. The SDK no longer fetches the source
  trace; app-server warms the cache from ClickHouse (shared spec §6.3).
- `src/debug/spine.ts` — delete. No spine detection, no `hasOverlap`, no
  `resolveCacheUntilSpanId`.
- The shared test vectors that drive spine/occurrence logic
  (`test/data/debug/*.json` for spine cases) — delete the spine-specific ones;
  keep / add the **hash parity** vector (§7).
- From `src/debug/index.ts`: `ReplayCache` import/use, `buildCache`,
  `awaitCacheReady`, `readyPromise`, `CACHE_READY_TIMEOUT_MS`, the `_counters`
  map, `getCached`, `setCache`. The async cache-fill window disappears entirely.
- From `src/debug/config.ts`: the **count form** of `cacheUntil`. `cacheUntil`
  becomes span-id-only (shared spec §3, §4). Remove `_parseCacheUntil`'s
  integer branch and the `cacheUntil: number` field; keep only the span-id
  needle (`cacheUntilSpanId`, normalized/suffix form). `replayEnabledForConfig`
  becomes `replayTraceId != null && cacheUntilSpanId != null`.
- From `src/debug/replay.ts`: `cachedPayloadFor` (occurrence-counter advance) —
  replaced by the per-call endpoint lookup. Keep `markSpanCached` and
  `spanPathFromSpan` (still useful for logging / span marking).

### Kept (do NOT change)
- `src/debug/pointer.ts` — run pointer mechanism unchanged (shared spec §3
  "Preserved"). `rollout.session_id` metadata key stays.
- The session registration call (`RolloutSessionsResource.register`) and the
  debugger-URL construction (`DebugRuntime.debuggerSessionUrl`,
  `recordProjectId`, `recordTraceId`).
- `markSpanCached` (`src/debug/replay.ts`) — still stamps
  `lmnr.span.type=CACHED` / `lmnr.span.original_type=LLM` on a served span.

### Added
- `src/debug/hash.ts` — the canonical input hash (shared spec §5): `canonicalJson`
  + `blake3` + system-message exclusion. Cross-language parity with the Python
  `hash.py` and app-server's `debug_input_hash`; shared test vector (§7).
- `src/debug/aisdk-normalize.ts` — the Vercel `ai.prompt.messages` reshape
  (shared spec §9, Option A). Reproduces app-server's
  `input_chat_messages_from_json` so the SDK hashes the same payload the server
  stored. **Trickiest surface** — see §4.
- A `cache` method on `RolloutSessionsResource`
  (`packages/client/src/resources/rollout-sessions.ts`) — POSTs to
  `/v1/rollouts/{session_id}/cache`, returns the discriminated HIT/MISS/COLD
  outcome (§5).
- A process-wide **"run live" static flag** on `Laminar` (shared spec §7.3),
  set on first MISS, reset in `shutdown()`.
- Rewritten `doGenerateOrStreamWithCaching` in `base-language-model.ts`: compute
  input hash → call the cache endpoint → HIT serves cached / MISS sets flag +
  live / COLD-degraded runs live this call (§3).

---

## 2. Config changes (`src/debug/config.ts`)

- `DebugConfig` loses `cacheUntil: number`; keeps `cacheUntilSpanId: string|null`
  (the suffix-match needle, normalized to hyphen-stripped lowercase hex).
- `replayEnabledForConfig(config)` ⇒ `replayTraceId != null && cacheUntilSpanId
  != null`. (Shared spec §4: both env vars must resolve non-empty.)
- `LMNR_DEBUG_CACHE_UNTIL` is parsed **only** as a span-id needle — drop the
  `int(value)` branch and the `/^[+-]?\d+$/` count guard. The four needle forms
  (full UUID / last-two-groups / raw 16-hex / short suffix) are still accepted;
  they are sent verbatim to app-server, which does the suffix match against the
  source trace's span ids (shared spec §6.2). The SDK no longer resolves the
  needle locally (no spine to resolve against).
- `loadLastRun` / `LMNR_DEBUG_FROM_LAST_RUN` unchanged **except** the pointer no
  longer persists a resolved integer `cacheUntil` — it persists the span-id
  needle as-is (there is no resolution step). Update `pointer.ts` callers in
  `index.ts` accordingly (the `cacheUntil` field in the pointer JSON becomes the
  span-id string; keep the field name for `last-run.json` back-compat).

> Parity: keep `config.ts` line-comparable with Python `config.py`. The truthy
> set, pointer field order, and `CONSOLE_PREFIX` stay byte-identical.

---

## 3. The replay consumer: `base-language-model.ts`

Rewrite `doGenerateOrStreamWithCaching` (lines ~271-298 today). New flow:

```
if (!replayEnabled()) return originalFn(options);          // unchanged gate
if (Laminar.debugRunLive) return originalFn(options);      // MISS flag latched
const messages = extractInputMessages(options);            // AI SDK prompt
const inputHash = debugInputHash(messages, options);       // §4, src/debug/hash.ts
const outcome = await Laminar.client.rolloutSessions.cache({
  sessionId, replayTraceId, cacheUntil, inputHash,
});
switch (outcome.kind) {
  case "hit":  markSpanCached(span); return buildFromCached(outcome.cached);
  case "miss": Laminar.debugRunLive = true; return originalFn(options);
  case "live": return originalFn(options);   // COLD-degraded (warmup timeout)
}
```

Key points:
- `replayEnabled()` keeps gating on `getRuntime()?.replayConfigured` — but
  `replayConfigured` is now just "replay is configured" (trace id + cache_until
  needle present); there's no async cache-load window to wait on, so the
  `awaitCacheReady()` call is **removed**.
- `Laminar.debugRunLive` (static) short-circuits BEFORE the network call once any
  call in this process has seen MISS. One redundant MISS call per distributed
  worker is the accepted v1 limitation (shared spec §7.2, §11).
- COLD is invisible to the SDK as a distinct branch in the happy path:
  app-server **blocks and warms**, then returns HIT or MISS. The only COLD the
  SDK ever sees is `"live"` — the warmup-timeout degrade (shared spec §7.2,
  §7 CRITICAL). On `"live"` we run live for THIS call only and do **not** set the
  static flag (next call retries the endpoint; the cache may be warm by then).
- The cached-response reconstruction (`cachedDoGenerate` / `cachedDoStream` /
  `parseCachedSpan` / `convertToContentBlocks`) is **kept as-is** — it already
  turns a `CachedSpan` (`output` + attributes) into AI SDK content blocks. The
  only change is where the `CachedSpan` comes from (endpoint, not in-memory cache).
- `buildFromCached` still needs a `CachedSpan`-shaped payload. The endpoint's HIT
  body carries the recorded output (shared spec §8: `lmnr.sdk.raw.response` else
  `gen_ai.output.messages` + finish reason). Map the HIT body into the existing
  `CachedSpan` shape so `parseCachedSpan` is untouched.

> The span the SDK marks CACHED is the **live** span being created for this call
> (`Laminar.getCurrentSpan()`), exactly as today. We never construct a
> `ReadableSpan` here, so the `makeSpanOtelV2Compatible` rule does not apply.

---

## 4. Input hashing + AI SDK normalization (§5, §9)

Two new modules, both on the cross-language parity surface for the hash but
TS-only for the reshape:

### `src/debug/hash.ts` — `debugInputHash(messages)`
Reproduce app-server's `canonical_json` + `blake3` + `extract_system_message`:
- `canonicalJson(value)`: objects → keys sorted lexicographically (recursive);
  arrays → order preserved; scalars → `JSON.stringify` equivalent. Hash the whole
  non-system message array as ONE blob (shared spec §5.1).
- System exclusion: strip the first `role === "system"` entry before hashing
  (handle string / array / parts content shapes), mirroring
  `extract_system_message` (`app-server/src/traces/prompt_hash.rs`)
  (shared spec §5.2).
- `blake3` over the canonical-json UTF-8 bytes → hex. Use a blake3 lib already in
  the dep tree if present; otherwise add one (check `pnpm why` before adding).
- **No number canonicalization** (shared spec §5.1 deferred). Document the
  limitation in a one-line comment.

### `src/debug/aisdk-normalize.ts` — the Vercel reshape (Option A)
- For the AI SDK provider, the messages the wrapper sees are
  `options.prompt` (the AI SDK `LanguageModelV*Prompt`). app-server stores
  `ai.prompt.messages` reshaped via `input_chat_messages_from_json`
  (`app-server/src/ch/spans.rs`) BEFORE hashing — so the SDK must apply the SAME
  reshape to `options.prompt` before `debugInputHash` (shared spec §9, §5.3).
- **v7/v4** (`@ai-sdk/provider-v4-canary`, `LanguageModelV4`): the SDK controls
  span content directly; the reshape is closer to identity. **v6/v3**
  (`@ai-sdk/provider`, `LanguageModelV3` / `@ai-sdk/provider-v2`): the
  `ai.prompt.messages` reshape study is needed. This is the trickiest part of the
  whole TS change — port `input_chat_messages_from_json` faithfully and pin it
  with the shared hash vector (§7).
- `extractInputMessages(options)` lives here and is version-aware (the base class
  already dispatches V2/V3/V4 via subclasses `v2.ts`/`v3.ts`/`v4.ts`).
- **Action item:** read `app-server/src/ch/spans.rs::input_chat_messages_from_json`
  and the existing AI SDK span-content code (`aisdk/utils.ts`, `aisdk/v*.ts`) and
  produce a faithful port. Revisit / consider dropping once everything is on v7+
  (shared spec §9).

> Python does NOT need a reshape module — its provider messages already match the
> stored shape (shared spec §9). `hash.py` mirrors `hash.ts` only.

---

## 5. Client resource: `RolloutSessionsResource.cache`

Add to `packages/client/src/resources/rollout-sessions.ts`:

```ts
type CacheOutcome =
  | { kind: "hit"; cached: CachedSpan }
  | { kind: "miss" }
  | { kind: "live" };   // COLD warmup-timeout degrade

public async cache({ sessionId, replayTraceId, cacheUntil, inputHash }): Promise<CacheOutcome>
```

- `POST /v1/rollouts/{sessionId}/cache`, body `{ replayTraceId, cacheUntil,
  inputHash }`, `this.headers()` (ProjectApiKey) — same auth/shape as the
  sibling `register` / `setName` / `delete` methods (shared spec §7.1).
- Parse app-server's discriminated response (the app-server plan §1 defines
  `Hit{response}/Miss{}/Live{}`) into the `CacheOutcome` union. Map the `Hit`
  body's recorded output into a `CachedSpan` so `base-language-model.ts` can feed
  it to the existing `parseCachedSpan`.
- Error posture: on a non-OK response, log + degrade to `{ kind: "live" }` for
  this call (best-effort, never crash the user's program). Do NOT latch the
  static flag on a transport error — only a real MISS latches it.

---

## 6. Static "run live" flag on `Laminar`

- Add a process-wide `static debugRunLive = false` on `Laminar`
  (`src/laminar.ts`).
- Set `true` on the first MISS (in `base-language-model.ts`).
- Reset to `false` in `Laminar.shutdown()` alongside `resetDebugRuntime()` so a
  later `initialize()` starts clean (shared spec §7.3). Keep the existing
  `debugExitHook` removal logic.

---

## 7. Tests & parity vectors

- **Hash parity vector** (`test/data/debug/input_hash_cases.json`): a set of
  `{ messages, expected_hash }` rows, byte-identical to the Python copy
  (`lmnr-python/tests/data/debug/`) and asserted against app-server's
  `debug_input_hash` (the app-server plan ships the same vector). This is the
  single most important test — it proves SDK ⟷ server hash agreement
  (shared spec §10 first checklist item).
- **AI SDK reshape vector**: `{ ai_prompt_messages_json, expected_canonical }`
  for v6/v3 and v7/v4, proving the §4 reshape matches
  `input_chat_messages_from_json`.
- Unit tests for the three outcomes in `base-language-model.ts` with a faked
  `rolloutSessions.cache` (HIT serves cached + marks span; MISS sets the static
  flag and the NEXT call skips the endpoint; LIVE runs live without setting the
  flag).
- Delete the spine / occurrence / overlap tests.
- `pnpm --filter @lmnr-ai/lmnr lint:fix` + `pnpm -r build` before commit
  (max line length 100, arrow functions — see repo CLAUDE.md).

---

## 8. Open questions / action items
1. Port `input_chat_messages_from_json` into `aisdk-normalize.ts` — confirm the
   v6/v3 vs v7/v4 split by reading `aisdk/v*.ts` + the app-server reshape.
2. Pick the blake3 lib (reuse if already a transitive dep; else add + pin).
3. Confirm the HIT body → `CachedSpan` mapping carries everything
   `parseCachedSpan` reads (`output`, `attributes["ai.response.finishReason"]`).
4. Confirm `Laminar.client` exposes `rolloutSessions` from the consumer's reach
   (the wrapper currently imports `Laminar`); thread the client through if not.
