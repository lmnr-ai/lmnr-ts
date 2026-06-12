# lmnr-cli

CLI for the [Laminar](https://lmnr.ai) agent observability platform.

## Installation

```bash
# Run directly with npx
npx lmnr-cli@latest <command>

# Or install globally
npm install -g lmnr-cli
```

## Quick start

One command takes you from a fresh install to a working API key in `./.env`:

```bash
lmnr-cli setup --json
```

Approve the device-flow URL in your browser, and `setup` will:

1. Log in (if you are not already)
2. Select (or create, in the browser) a workspace + project — idempotent on re-runs in the same repo
3. Mint a fresh API key and write `LMNR_PROJECT_API_KEY=...` to `./.env`
4. Link the directory via `.lmnr/project.json` and install the Laminar agent skill into `.claude/` and `.agents/`
5. Print a dashboard URL and the revoke link

```bash
# Verify traces are arriving:
lmnr-cli sql query "SELECT count() FROM spans"
```

`setup` is designed to be invoked by coding agents. Exit codes:

- `0` success
- `1` generic error
- `4` no access to the linked project
- `6` login failed or aborted
- `7` no project to select (and none could be created)
- `8` `.env` write failed (the API key is surfaced on stderr so the agent can rescue it)
- `9` API key mint failed
- `10` project discovery (`GET /v1/cli/projects`) failed
- `11` couldn't verify an existing key (network/server error)
- `12` existing key belongs to a different project

See `lmnr-cli setup --help` for all flags.

## Authentication

The CLI authenticates as a **user** via the OAuth Device Flow (`lmnr-cli login`).
Every command runs on that user session — there is no project-API-key auth mode.
Project commands (`sql`, `dataset`, `trace`, `debug`) target a project via
`--project-id` or the `.lmnr/project.json` link written by `lmnr-cli setup`.

The project API key that `setup` writes to `./.env` is for your **application's
SDK** (trace ingestion) — the CLI itself never reads it.

### OAuth Device Flow

```bash
# Start the device authorization flow. Prints a URL + code and opens your browser.
lmnr-cli login

# Self-hosted / headless: point at your deployment, don't auto-open a browser.
lmnr-cli login --frontend-url http://localhost:3010 --no-browser

# Log out (revokes the session server-side, best-effort, then removes local creds).
lmnr-cli logout
```

The CLI signs in **one user at a time**. Tokens are stored at
`~/.config/lmnr/credentials.json` with mode `0600` (XDG-aware via
`$XDG_CONFIG_HOME`; `%APPDATA%\lmnr` on Windows). Access tokens are
auto-refreshed when within ~30 seconds of expiry; if the session has been
revoked or expired, the CLI exits with an error and you must run
`lmnr-cli login` again.

### Targeting a project

Project commands resolve their project from `--project-id`, falling back to the
`.lmnr/project.json` link that `lmnr-cli setup` writes in the directory:

```bash
lmnr-cli setup                                            # link this directory
lmnr-cli sql query "SELECT count() FROM spans"            # uses the .lmnr link
lmnr-cli sql query "SELECT count() FROM spans" --project-id <uuid>  # override
lmnr-cli project list                                     # projects you can access (● = linked)
```

For a self-hosted Laminar instance, point the CLI at your deployment. `--base-url`
is the data API and carries **no port** — pass the port separately with `--port`:

```bash
lmnr-cli sql schema --base-url http://localhost --port 8000
```

`LMNR_FRONTEND_URL` (default `https://laminar.sh`), `LMNR_BASE_URL`
(default `https://api.lmnr.ai`), and `LMNR_HTTP_PORT` (default `443`) are also
honored, and are auto-loaded from a `.env` / `.env.local` in the working directory.

## Commands

### [`sql`](src/commands/sql/README.md) - SQL Queries

Run SQL queries against your Laminar project data (spans, traces, events, and more).

```bash
lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
lmnr-cli sql schema                                      # Show available tables
```

### [`dataset`](src/commands/dataset/README.md) - Dataset Management

List, push, pull, and create datasets in your Laminar project.

```bash
lmnr-cli dataset list --json                             # List all datasets
lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
lmnr-cli dataset create my-dataset data.jsonl -o out.jsonl
```

### `trace` / `debug` - Annotate and inspect agent runs

Record findings on a trace and review/name agent debug sessions.

```bash
lmnr-cli debug session new                               # Mint a fresh debug session
lmnr-cli debug session open                              # Open the session in the browser
lmnr-cli trace append-note "note text"                   # Markdown note on the latest debug trace
lmnr-cli debug session set-name "title"                  # Rename the current debug session
lmnr-cli debug session summary                           # Every trace in the session + its note
```

These commands default to the session/trace recorded in
`.lmnr/debug-session.json` (written by `debug session new` and `LMNR_DEBUG=1`
runs); target another one with an explicit id
(e.g. `lmnr-cli debug session summary <session-id>`,
`lmnr-cli trace append-note "note" --trace-id <trace-id>`).

`trace append-note` accumulates (each call appends a paragraph). See the Laminar
debugger docs: https://laminar.sh/docs/platform/debugger

### `setup` - One-shot onboarding

```bash
lmnr-cli setup                              # Human-readable summary
lmnr-cli setup --json                       # Machine-readable single-line JSON
lmnr-cli setup --project-id <uuid>          # Disambiguate when you can access >1 project
lmnr-cli setup --no-write-env               # Skip writing ./.env
lmnr-cli setup --no-browser                 # Don't auto-open the device-flow URL
```

Re-running setup in the same repo reuses the same project but mints a fresh API
key each time. Old keys remain visible in the dashboard under "API keys" until
you revoke them.

### `login` / `logout` - Authentication

See [Authentication](#authentication) above.

### `project list` - Discovery

Lists the projects you can access; the one linked to the current directory is
marked with `●`. Accepts `--json`.

## Global Options

- `-v, --version` - Display version number
- `-h, --help` - Display help

Project commands (`sql`, `dataset`, `trace`, `debug`, `project`) also accept:

- `--project-id <id>` - Target project (defaults to the `.lmnr/project.json` link written by `setup`)
- `--base-url <url>` - Base URL for the Laminar API, no port (default: https://api.lmnr.ai)
- `--port <port>` - Port for the Laminar API (default: 443)
- `--json` - Output structured JSON to stdout

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run locally
node dist/index.cjs <command>

# Run tests
pnpm test
```

## License

Apache-2.0
