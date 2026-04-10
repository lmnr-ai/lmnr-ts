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
