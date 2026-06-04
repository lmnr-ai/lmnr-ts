# lmnr-cli

CLI for the [Laminar](https://lmnr.ai) agent observability platform.

## Installation

```bash
# Run directly with npx
npx lmnr-cli@latest <command>

# Or install globally
npm install -g lmnr-cli
```

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
