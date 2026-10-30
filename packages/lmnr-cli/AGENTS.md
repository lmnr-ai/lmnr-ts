This is a CLI for the Laminar agent observability platform.

Command-specific notes live in nested `AGENTS.md` files next to the code (each with a `CLAUDE.md` symlink so Claude Code loads it on demand). Read the relevant one before editing a command; the index is at the bottom of this file.

## Output strategy
- Logger (pino) always writes to stderr. This keeps stdout clean for data output for piping and agents.
- Commands that support machine-readable output must accept a `--json` flag. This is added per command group (e.g. datasets), not globally, since interactive commands cannot support it.

## Package Boundaries
- `lmnr-cli` is the standalone CLI (`npx lmnr-cli@latest`). It depends on
  `@lmnr-ai/client` for API calls, not the full `@lmnr-ai/lmnr` SDK.
- `lmnr-cli` has NO dependency on `@lmnr-ai/lmnr`. The old `dev` command (the
  interactive debugger / worker resolution) was removed in the debugger rework —
  debug runs are now plain processes driven by `LMNR_DEBUG*` env vars against the
  server-side replay cache v2 (see `@lmnr-ai/lmnr` `src/debug/`). Do NOT
  re-introduce a `@lmnr-ai/lmnr` peer dep or the previously-known circular
  dependency.
- lmnr-cli imports `@lmnr-ai/client` / `@lmnr-ai/types` from their built
  `dist`, so a new client method is invisible to the CLI (and its integration
  tests) until `pnpm --filter @lmnr-ai/types build && pnpm --filter
  @lmnr-ai/client build`.

## Guideline Resources

### [Writing CLI Tools that AI Agents Actually Want To Use](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)
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

## Nested AGENTS.md files

- `src/commands/debug/AGENTS.md` - debug sessions, `.lmnr/debug-session.json` resolution and contract, notes as session blocks
- `src/commands/eval/AGENTS.md` - `eval run` / `eval orchestrate` (Harbor evals): modes, remote image push, detached runs, exit codes
- `src/commands/llm-profile/AGENTS.md` - LLM profile CRUD, provider flags, update semantics
- `src/commands/setup/AGENTS.md` - probing an existing project API key
- `src/commands/signal/AGENTS.md` - trigger / filter / mode flags, repeatable flags, partial updates, backfill
- `src/commands/skill/AGENTS.md` - skill install core and its two failure policies
