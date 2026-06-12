This is a CLI for the Laminar agent observability platform.

# Output strategy
- Logger (pino) always writes to stderr. This keeps stdout clean for data output for piping and agents.
- Commands that support machine-readable output must accept a `--json` flag. This is added per command group (e.g. datasets), not globally, since interactive commands cannot support it.

# Package Boundaries
- `lmnr-cli` is the standalone CLI (`npx lmnr-cli@latest`). It depends on
  `@lmnr-ai/client` for API calls, not the full `@lmnr-ai/lmnr` SDK.
- `lmnr-cli` has NO dependency on `@lmnr-ai/lmnr`. The old `dev` command (the
  interactive debugger / worker resolution) was removed in the debugger rework —
  debug runs are now plain processes driven by `LMNR_DEBUG*` env vars against the
  server-side replay cache v2 (see `@lmnr-ai/lmnr` `src/debug/`). Do NOT
  re-introduce a `@lmnr-ai/lmnr` peer dep or the previously-known circular
  dependency.

# Debug sessions (`src/commands/debug/`)
- `lmnr-cli debug session new` mints a fresh session id and **resets**
  `.lmnr/debug-session.json` to it, then best-effort registers it with the
  backend. Ordering is deliberate: the local file is written FIRST (so the minted
  session is usable for `LMNR_DEBUG=1` continuation even if the network/endpoint
  is unavailable), THEN `client.rolloutSessions.register({ sessionId })` runs —
  this routes to `POST /v1/cli/rollouts/{id}` because the CLI client is
  userToken-auth. A register failure WARNS but does NOT fail the command (exit 0);
  the file is already written. Once the project id is known, the file is rewritten
  with the full `debugger_url`. The next `LMNR_DEBUG=1 <run>` in the directory
  reads the file and rejoins this session silently (no browser) — "new session" is
  owned by this command; the SDK only mints when no file exists.
- **All session/trace-scoped commands default their id from
  `.lmnr/debug-session.json`**: `debug session summary [session-id]`,
  `debug session open [session-id]`, `debug session set-name <name> [session-id]`,
  and `trace append-note <note> [trace-id]` (falls back to the file's `trace_id`
  — the root trace of the most recent debug run). The payload positional comes
  FIRST, the optional id LAST. Resolution lives in
  `src/utils/debug-session-file.ts` (`resolveSessionId` / `resolveTraceId`),
  which throws an actionable error when neither the argument nor the file is
  available — the wrapper's error envelope formats it.
- The `.lmnr/debug-session.json` **CONTRACT is shared** via `@lmnr-ai/types`
  (`DebugSessionFile` + `DEBUG_SESSION_DIR`/`DEBUG_SESSION_FILE` consts), which
  stays type-only (no `node:fs`). The sync fs read/write helpers live in each
  runtime consumer — CLI: `src/utils/debug-session-file.ts`, SDK:
  `src/debug/debug-session-file.ts` — both importing the shared contract so the
  on-disk shape can't drift. This does NOT re-introduce an SDK dep.
- The debugger URL is built from `LMNR_FRONTEND_URL` (env, trailing slashes
  trimmed) with `DEFAULT_FRONTEND_URL` as the cloud fallback — see
  `buildDebuggerUrl` in `src/commands/debug/index.ts`.
- `debug session open` is **local-only** (registered via `withLocalOpts`, not
  `withProjectClient`): it resolves everything from disk (`debug-session.json`'s
  `debugger_url` when it matches the session, else `--project-id` /
  `.lmnr/project.json` + `LMNR_FRONTEND_URL`) so it works offline/before login.
- Output contract for `session new`: `--json` emits
  `{sessionId, projectId, debuggerUrl}` on stdout; otherwise the bare session id
  goes to stdout (agent-capturable) and the human-facing URL to stderr (via the
  logger). `--no-browser` suppresses the default browser open. `session open`
  prints the URL to stdout (`{sessionId, debuggerUrl}` in `--json` mode).

# Guideline Resources

## [Writing CLI Tools that AI Agents Actually Want To Use](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)
Here are guidelines from the above article.

If you are going to build out a new feature, make sure you read that article to understand important guidelines.
- --json flag for structured output
- JSON to stdout, messages to stderr
- Meaningful exit codes (not just 0/1)
- Idempotent operations (or clear conflict handling)
- Comprehensive --help with examples
- --dry-run for destructive commands
- --yes/--force to bypass prompts
- --quiet for pipe-friendly bare output
- Consistent field names and types across commands
- Consistent noun-verb hierarchy (e.g., `noun verb`)
- Actionable error messages with error codes
- Batch operations for bulk work
- Non-interactive TTY detection
