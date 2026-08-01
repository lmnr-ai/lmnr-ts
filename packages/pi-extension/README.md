# @lmnr-ai/pi-extension

[![npm](https://img.shields.io/npm/v/@lmnr-ai/pi-extension)](https://www.npmjs.com/package/@lmnr-ai/pi-extension)
[![license](https://img.shields.io/npm/l/@lmnr-ai/pi-extension)](https://github.com/lmnr-ai/lmnr-ts/blob/main/LICENSE)

[Laminar](https://laminar.sh) observability for the [pi coding agent](https://pi.dev). A pi extension that emits, **live and in-process**, one Laminar trace per agent run — with granular LLM and tool spans — over OTLP/HTTP. No build step, no code changes to your agent, and fully fail-open.

## Install

```sh
pi install npm:@lmnr-ai/pi-extension
```

Set your Laminar project key and run pi as usual:

```sh
export LMNR_PROJECT_API_KEY="..."   # from https://laminar.sh
pi -p "…"
```

That's it — every agent run now streams a trace to Laminar. With no key set, the extension disables itself silently, so it's safe to leave installed.

<details><summary>Other install methods</summary>

```sh
pi install git:github.com/lmnr-ai/lmnr-ts#subdir=packages/pi-extension   # from the monorepo
pi install /path/to/pi-extension                                         # from a local path
```

Or declare it in `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@lmnr-ai/pi-extension"] }
```

</details>

## What you get

One Laminar **trace per pi agent run** (`before_agent_start` → `agent_end`), with fully granular child spans opened and closed in realtime:

```
pi agent run          (DEFAULT)   ← the whole run
├─ LLM call (turn 0)  (LLM)       ← each model call, with token usage + cost
├─ bash               (TOOL)      ← each tool execution
├─ LLM call (turn 1)  (LLM)
└─ …
```

- **Live streaming** — spans export as they close, not batched at the end.
- **Cost + tokens** — emitted under Laminar's canonical `gen_ai.usage.*` attributes.
- **Debugger sessions** — group runs into a Laminar debugger session (see below).
- **Evaluation-aware** — under a harness that injects a parent span (e.g. Harbor), pi's trace nests beneath it and inherits its trace type (e.g. `EVALUATION`), so eval traces are classified correctly.
- **Fail-open** — any tracing or export error is swallowed; it can never break an agent run.

## Configuration

All configuration is via environment variables (no secrets in files):

| Variable | Required | Description |
|---|---|---|
| `LMNR_PROJECT_API_KEY` | yes | Laminar project key. Absent ⇒ tracing disabled (fail-open). |
| `LMNR_BASE_URL` | no | Laminar API base URL (default `https://api.lmnr.ai`). |
| `LMNR_USER_ID` | no | Associates traces with a user id. |
| `LMNR_DEBUG` | no | Truthy ⇒ enable debugger sessions + a local log at `~/.pi/agent/lmnr-pi-extension.log`. |
| `LMNR_DEBUG_SESSION_ID` | no | Pin a specific debugger (rollout) session id. |
| `LMNR_MAX_CHARS` | no | Truncation cap for span input/output (default `20000`). |

## Debugger sessions

With `LMNR_DEBUG` truthy, each run joins a Laminar **debugger session** so it shows up in the debugger UI. The session id resolves exactly like the Laminar SDK: `LMNR_DEBUG_SESSION_ID` → the nearest `.lmnr/debug-session.json` (written by `lmnr-cli debug session new`) → a freshly minted UUID.

```sh
lmnr-cli debug session new      # open a session (writes .lmnr/debug-session.json)
LMNR_DEBUG=true pi -p "…"        # runs join that session automatically
lmnr-cli debug session summary  # see your run as a <trace> block
```

## Evaluation / harness integration

When an upstream harness injects a serialized Laminar span context via `LMNR_SPAN_CONTEXT`, the extension nests pi's trace under that parent span (sharing its trace id) and carries the parent's `trace_type` (e.g. `EVALUATION`) onto every span. So a harness like [Harbor](https://github.com/lmnr-ai) gets pi's LLM/tool spans under its evaluation trace, classified correctly — no configuration required; it's automatic whenever the env var is present.

## Develop

This package lives in the [`lmnr-ts`](https://github.com/lmnr-ai/lmnr-ts) monorepo (pnpm workspace). From the repo root:

```sh
pnpm install
pnpm --filter @lmnr-ai/pi-extension typecheck   # tsc --noEmit
pnpm --filter @lmnr-ai/pi-extension test         # node:test via tsx — unit + end-to-end OTLP-capture tests
pi -e "$PWD/packages/pi-extension/src/index.ts" -p "…"   # load the local source directly
```

There is **no build step** — pi runs the TypeScript entry (`src/index.ts`) directly via jiti, so the shipped source is exactly what runs. The end-to-end test drives the extension with synthetic pi events against a local OTLP capture server and asserts the resulting span tree — no network or Laminar account required.

The extension deliberately depends only on raw OpenTelemetry at runtime (not the Laminar SDK) so it stays light enough to upload into a sandbox. It reuses shared *type* definitions (`SpanType`, `DebugSessionFile`) from [`@lmnr-ai/types`](../types) as type-only imports, which are erased at runtime.

## License

Apache-2.0 © LMNR AI, Inc.
