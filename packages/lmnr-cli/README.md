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
2. Create or reuse a workspace + project (idempotent on re-runs in the same repo)
3. Mint a fresh API key and write `LMNR_PROJECT_API_KEY=...` to `./.env`
4. Print a dashboard URL and the revoke link

```bash
# Verify your instrumentation runs end-to-end:
lmnr-cli traces wait --since 60s --count 1
```

`setup` is designed to be invoked by coding agents. Exit codes:

- `0` success
- `1` generic error
- `6` login failed or aborted
- `7` ambiguous workspace (multiple workspaces, no `--workspace`, non-interactive)
- `8` `.env` write failed (API key is surfaced on stderr so the agent can rescue it)

See `lmnr-cli setup --help` and `lmnr-cli traces wait --help` for all flags.

## Authentication

The CLI supports three authentication modes, evaluated in this precedence order:

1. `--project-api-key <key>` flag
2. `LMNR_PROJECT_API_KEY` environment variable
3. OAuth Device Flow (via `lmnr-cli login`)

### OAuth Device Flow

```bash
# Start the device authorization flow.  Prints a URL + code, opens your browser.
lmnr-cli login

# (Optionally pre-select a project)
lmnr-cli login --project <project-uuid>

# Show the current login state and token expiry.
lmnr-cli status

# Remove the stored credentials.
lmnr-cli logout
```

Tokens are stored at `~/.config/lmnr/credentials.json` with mode `0600` (parent
directory `0700`, XDG-aware via `$XDG_CONFIG_HOME`). Access tokens are
auto-refreshed when within 30 seconds of expiry; if the refresh token has been
revoked or rotated, the CLI exits with an error and you must run
`lmnr-cli login` again.

For a self-hosted Laminar instance, point the CLI at your deployment:

```bash
lmnr-cli login --dashboard-url http://localhost:3010 --base-url http://localhost:8010
```

`LMNR_DASHBOARD_URL` (defaults to `https://www.laminar.sh`) and `LMNR_BASE_URL`
(defaults to `https://api.lmnr.ai`) are also honored.

## Commands

### [`sql`](src/commands/sql/README.md) - SQL Queries

Run SQL queries against your Laminar project data (spans, traces, events, and more).

```bash
lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
lmnr-cli sql schema                                      # Show available tables
```

### [`dev`](src/commands/dev/README.md) - Agent Debugger

Start a language-agnostic debugging session for your AI agents. Connects to the Laminar backend, spawns a worker process for your code, and orchestrates the debugging flow.

```bash
lmnr-cli dev agent.ts                    # TypeScript file
lmnr-cli dev agent.py                    # Python script mode
lmnr-cli dev -m src.agent                # Python module mode
lmnr-cli dev agent.ts --function myAgent # Specific function
```

### [`dataset`](src/commands/dataset/README.md) - Dataset Management

List, push, pull, and create datasets in your Laminar project.

```bash
lmnr-cli dataset list --json                             # List all datasets
lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
lmnr-cli dataset create my-dataset data.jsonl -o out.jsonl
```

### `setup` - One-shot onboarding

```bash
lmnr-cli setup                              # Human-readable summary
lmnr-cli setup --json                       # Machine-readable single-line JSON
lmnr-cli setup --workspace <uuid>           # Target a specific workspace
lmnr-cli setup --project-name my-app        # Use an explicit project name
lmnr-cli setup --no-write-env               # Skip writing ./.env
```

Re-running setup in the same repo reuses the same project but mints a fresh API
key each time. Old keys remain visible in the dashboard under "API keys" until
you revoke them.

### `traces wait` - Wait for trace ingestion

```bash
lmnr-cli traces wait --since 60s --count 1 --timeout 120s
lmnr-cli traces wait --since 2m --count 5 --json
```

Polls the server every 2 seconds. Useful for coding agents that need to confirm
their instrumentation actually emits traces before declaring "done".

### `login` / `logout` / `status` - Authentication

See [Authentication](#authentication) above.

## Global Options

- `-v, --version` - Display version number
- `-h, --help` - Display help

Each command also accepts:

- `--project-api-key <key>` - Project API key (or set `LMNR_PROJECT_API_KEY` env variable, or log in via `lmnr-cli login`)
- `--base-url <url>` - Base URL for the Laminar API (default: https://api.lmnr.ai)
- `--port <port>` - Port for the Laminar API (default: 443)

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
