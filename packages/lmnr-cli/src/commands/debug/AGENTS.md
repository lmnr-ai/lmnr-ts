# Debug sessions (`debug`, `src/utils/debug-session-file.ts`)

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
- **All session-scoped commands default their id from
  `.lmnr/debug-session.json`, and explicit ids are ALWAYS flags, never
  positionals**: `debug session summary [--session-id <id>]`,
  `debug session open [--session-id <id>]`,
  `debug session set-name <name> [--session-id <id>]`, and
  `debug session add-note <note> [--session-id <id>]`. Positionals are payload
  only (name / note), so a stray extra positional fails fast at commander
  instead of being silently treated as an id. Resolution lives in
  `src/utils/debug-session-file.ts` (`resolveSessionId`), which throws an
  actionable error when neither the argument nor the file is available — the
  wrapper's error envelope formats it.
- **Notes are session `text` blocks, not trace/eval metadata.**
  `debug session add-note` posts a standalone `text` block to the session via
  `client.rolloutSessions.addBlock({ sessionId, type: "text", content: { text } })`
  (`POST /v1/cli/rollouts/{sessionId}/blocks`), keyed only by session id — there
  is no `trace append-note` / `eval note` any more. `rollout.session_id` still
  links traces (LMNR_DEBUG runs) and evals (`withSessionMetadata` in the SDK) to
  the session so the backend writes `trace` / `evaluation` blocks at ingest;
  `debug session summary` reads the whole block list back via
  `client.rolloutSessions.listBlocks` (`GET .../blocks`) and prints
  trace/eval/text blocks oldest-first. `SessionBlock` + content shapes live in
  `@lmnr-ai/types` (`session-block.ts`).
- **There is NO `lmnr-cli eval` command.** Evals are just normal
  Laminar-instrumented programs — run them directly under `LMNR_DEBUG=1`. The SDK
  resolves the session id the same way it does for traces (`buildDebugConfig`:
  `LMNR_DEBUG_SESSION_ID` env → `.lmnr/debug-session.json` → minted) and
  `withSessionMetadata` (`packages/lmnr/src/evaluations.ts`) stamps
  `getRuntime()?.sessionId` into the eval's `evals.init` metadata as
  `rollout.session_id`, so the backend writes the `evaluation` block. Because the
  session was resolved FROM `debug-session.json`, the SDK's `emitPointer`
  shutdown write is NOT skipped by the clobber guard, so `debug-session.json`
  stays pointed at the current session for `add-note` / `summary` / `open` — no
  CLI wrapper, no `eval-sessions.json`, no parent-process pointer write. Start a
  fresh session with `lmnr-cli debug session new` (same as for traces).
- **The session file is found by walking UP from cwd** (`findDebugSessionDir` /
  `resolveDebugSessionDir`, mirrored in the SDK's
  `src/debug/debug-session-file.ts`): the nearest ancestor with a usable
  `.lmnr/debug-session.json` wins, so commands work from subdirectories of a
  project — same nearest-wins rule as `.lmnr/project.json`. Read and write
  share that anchor: `debug session new` RESETS the nearest existing file
  (project-scoped, no shadowing nested copies) and only creates one in cwd when
  no ancestor has one. The SDK reads/writes through the same resolution, so
  `LMNR_DEBUG=1` runs from a subdirectory join the session the CLI sees.
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
