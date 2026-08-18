This is a CLI for the Laminar agent observability platform.

# Output strategy
- Logger (pino) always writes to stderr. This keeps stdout clean for data output for piping and agents.
- Commands that support machine-readable output must accept a `--json` flag. This is added per command group (e.g. datasets), not globally, since interactive commands cannot support it.

# Setup: resolving an existing project API key
- `lmnr-cli setup` checks whether an existing `LMNR_PROJECT_API_KEY` in the
  environment / `.env` already points at the linked project before minting a new
  one. By setup time the CLI is **already logged in**, so this probe authenticates
  as the USER (JWT bearer) via `client.cli.resolveProjectByApiKey(apiKey)`
  (`@lmnr-ai/client`, `POST /v1/cli/project`, key in the body) — NOT by deriving
  auth from the project key itself. The server also confirms the user is a member
  of the resolved project. The result is a tri-state `ProjectKeyProbe`: `ok`
  (with `projectId`), `invalid` (401 → key revoked, safe to mint), `unverifiable`
  (403 / network / other non-2xx → do NOT mint, would clobber a possibly-valid
  key on a blip). The local helper is `probeProjectKey` in
  `src/commands/setup/index.ts`. The old standalone `GET /v1/project` probe
  (`src/auth/project-id.ts`) was DELETED — do not reintroduce a key-authed probe.

# Signals (`src/commands/signal/`)

- **A signal's firing config is THREE independent flags, not one nested blob**:
  `--trigger` (WHEN it's evaluated: `root-span-finished` | `span-name`, with
  `--span-name` repeatable for the second), `--filter` (WHETHER it runs,
  repeatable JSON, ANDed) and `--mode` (`batch` | `realtime`). They map to the
  API's `trigger` / `filters` / `mode`. `--trigger` is a KIND, never a column
  list. Omitted on create → `root-span-finished`; there is no "no trigger" flag.
- **`--filter` stays `{column, operator, value}` JSON — do NOT turn it into a
  `"col op value"` DSL.** Filters are meant to be versatile and extensible: new
  operators, array/nested values, and extra keys must reach the server without a
  CLI release, so `parseFilter` checks only the wire shape and spreads unknown
  keys through.
- **`--span-name` without `--trigger span-name` is an ERROR, not an implied kind
  switch.** Inferring the kind would let a typo'd `--trigger` quietly change when
  the signal fires — the exact failure class this command is shaped to prevent.
- **Repeatable flags must use the shared `collectFlag` and NOT a commander `[]`
  default.** With a default the handler always receives an array, so an absent
  flag reads as "passed empty": `signal update --prompt x` CLEARED the signal's
  filters, and `create` sent `filters: []` instead of omitting the key for the
  server default. This shipped broken once; `validate.test.ts` covers it.
- `validate.ts` only translates flag syntax into the wire shape and fills omitted
  schema `type`/`required`. Do NOT re-implement column allowlists, sample-rate
  bounds, or field-name regexes here — they drift from `signals/service.rs`.
  `--filter` deliberately does not validate the column, so a bad one reaches the
  server and its 400 names the supported ones (shown verbatim via
  `raiseSignalError`).
- `signal update` is a PARTIAL patch, and the three firing flags are independent —
  changing `--mode` leaves the trigger and filters alone. Omitted flags leave
  stored values alone. `--no-sampling` sends `sampleRate: null` (clears the
  stored rate; evaluate every matching trace). `--no-filters` sends `filters: []`.
  An empty patch is an error listing the valid flags, never a silent no-op.
- `<signal>` accepts an id or a name. An ambiguous name is an ERROR listing the
  candidates rather than a silent pick — `update` / `delete` are destructive.
- `SignalsResource` (`@lmnr-ai/client`) overrides error handling with its own
  `raiseSignalError` instead of `BaseResource.handleError`: signal routes answer
  `{error: "<message>"}` with user-facing text, and the shared handler would
  print the raw JSON body at the user (`409 {"error":"..."}`).

# Evals (`src/commands/eval/`)

- The `eval` group is **read + tag management only**: `list` / `get` / `tag` /
  `untag`. It never runs an evaluation — running one is `LMNR_DEBUG=1 <your
  script>` (see the debug-sessions section above). Keep it that way; a `run`
  subcommand would re-introduce the `@lmnr-ai/lmnr` dep the CLI deliberately
  doesn't have.
- Tags live at the EVALUATION level (Postgres `evaluation_tags`), and the name
  registry is the same `tag_classes` table the UI's trace/span tag picker uses —
  so a tag created by `eval tag` shows up in the UI picker immediately. Attaching
  an unknown name creates the tag class server-side; nothing to pre-create.
- `--tag` on `eval list` is repeatable and ANDed ("carries all of these"), and
  goes over the wire as a single comma-joined `tags` query param. It uses the
  shared `collectFlag` (no commander `[]` default) for the same reason `signal`
  does.
- `EvalsResource` methods added for this surface (`list` / `get` / `addTags` /
  `removeTag`) use `this.apiPrefix`, so they hit `/v1/cli/evals` under CLI
  user-token auth and `/v1/evals` under a project API key. The older
  datapoint-oriented methods on that resource hard-code `/v1` — don't "unify"
  them, they are SDK-only. Like signals, the new methods unwrap
  `{error: "<message>"}` envelopes (`raiseEvalError`) instead of using
  `BaseResource.handleError`.

# Package Boundaries
- `lmnr-cli` is the standalone CLI (`npx lmnr-cli@latest`). It depends on
  `@lmnr-ai/client` for API calls, not the full `@lmnr-ai/lmnr` SDK.
- `lmnr-cli` has NO dependency on `@lmnr-ai/lmnr`. The old `dev` command (the
  interactive debugger / worker resolution) was removed in the debugger rework —
  debug runs are now plain processes driven by `LMNR_DEBUG*` env vars against the
  server-side replay cache v2 (see `@lmnr-ai/lmnr` `src/debug/`). Do NOT
  re-introduce a `@lmnr-ai/lmnr` peer dep or the previously-known circular
  dependency.

# Skill install (`src/utils/install-skill.ts`, `src/commands/skill/`)
- One shared core, two failure policies: `installSkillInto(cwd, agentDirs)` downloads once
  into a temp staging dir and REPLACES `<dir>/skills/laminar` in each target, and it THROWS
  on failure. `setup` wraps it in `installSkill()` (best-effort: warn + `skipped: true`,
  never breaks setup), while `skill add` / `skill update` let the error envelope surface the
  failure — installing the skill IS the command there. Don't collapse the two policies.
- Target resolution is split by intent: `resolveInstallTargets` (present agent dirs, else
  default `.claude` + `.agents`) is for fresh installs (setup / `skill add`);
  `findInstalledSkillDirs` (dirs already holding `skills/laminar`) is for `skill update`,
  which must NOT create new copies and errors when none are installed.
- `skill add` / `skill update` are local-only commands (`withLocalOpts`) — no login, no
  client; the only network hit is the giget download of the skill tarball.

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
- **`lmnr-cli eval` does NOT run evals** (see the `eval` group section below for
  what it does do). Evals are just normal
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
