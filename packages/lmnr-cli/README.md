# lmnr-cli

CLI for the [Laminar](https://lmnr.ai) agent observability platform.

## Installation

```bash
# Run directly with npx
npx lmnr-cli@latest <command>

# Or install globally
npm install -g lmnr-cli
```

## Commands

### `setup` - Zero-to-first-trace

Browser-based authorization that writes `LMNR_PROJECT_API_KEY` to `./.env`.
Opens the Laminar dashboard via a local loopback + PKCE flow, lets you pick (or
create) a project, and mints a project API key. `./.env` is the only artifact
`setup` writes — there is no credentials file.

```bash
lmnr-cli setup                 # Browser flow, write ./.env
lmnr-cli setup --no-browser    # Headless: print a URL, paste the key back
```

Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `1`  | Generic failure |
| `6`  | Auth failed / not logged in |
| `8`  | `.env` write failed — the API key was minted and is printed on stderr so the caller can rescue it (distinct code so coding agents can branch) |

### Authentication

The CLI's only auth artifacts are the `--project-api-key` flag and the
`LMNR_PROJECT_API_KEY` env var. Resolution order (highest priority first) used
by every command that needs a project API key:

1. `--project-api-key <key>` CLI flag
2. `LMNR_PROJECT_API_KEY` env var (e.g. written to `./.env` by `setup`)
3. Hard error with a pointer to `setup`

CI flows that already set `LMNR_PROJECT_API_KEY` are unaffected.

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

## Global Options

- `-v, --version` - Display version number
- `-h, --help` - Display help

Each command also accepts:

- `--project-api-key <key>` - Project API key (or set `LMNR_PROJECT_API_KEY` env variable)
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
