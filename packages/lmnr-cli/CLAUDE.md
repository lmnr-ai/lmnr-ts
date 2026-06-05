This is a CLI for the Laminar agent observability platform.

# Output strategy
- Logger (pino) always writes to stderr. This keeps stdout clean for data output for piping and agents.
- Commands that support machine-readable output must accept a `--json` flag. This is added per command group (e.g. datasets), not globally, since interactive commands cannot support it.

# Package Boundaries
- `lmnr-cli` is the standalone CLI (`npx lmnr-cli@latest`). It depends on
  `@lmnr-ai/client` for API calls, not the full `@lmnr-ai/lmnr` SDK.
- `lmnr-cli` has NO dependency on `@lmnr-ai/lmnr`. The old `dev` command (the
  interactive debugger / worker resolution) was removed in the debugger rework —
  debug runs are now plain processes driven by `LMNR_DEBUG*` env vars with an
  in-process replay cache (see `@lmnr-ai/lmnr` `src/debug/`). Do NOT re-introduce
  a `@lmnr-ai/lmnr` peer dep or the previously-known circular dependency.

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
