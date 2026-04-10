# lmnr-cli dataset

Manage datasets in your Laminar project from the command line.

## Usage

```bash
lmnr-cli dataset <command> [options]
```

### Global Options

These options apply to all dataset subcommands:

- `--project-api-key <key>` - Project API key (or set `LMNR_PROJECT_API_KEY` env variable)
- `--base-url <url>` - Base URL for the Laminar API (default: https://api.lmnr.ai)
- `--port <port>` - Port for the Laminar API (default: 443)
- `--json` - Output structured JSON to stdout

## Commands

### `dataset list`

List all datasets in your project.

```bash
lmnr-cli dataset list
lmnr-cli dataset list --json
```

### `dataset push`

Push datapoints to an existing dataset from local files.

```bash
lmnr-cli dataset push <paths...> [options]
```

**Arguments:**
- `<paths...>` - Paths to files or directories containing data to push

**Options:**
- `-n, --name <name>` - Name of the dataset (either name or id must be provided)
- `--id <id>` - ID of the dataset (either name or id must be provided)
- `-r, --recursive` - Recursively read files in directories
- `--batch-size <size>` - Batch size for pushing data (default: 100)

**Examples:**
```bash
lmnr-cli dataset push data.jsonl -n my-dataset
lmnr-cli dataset push data/ -n my-dataset -r --json
```

### `dataset pull`

Pull datapoints from a dataset to a local file or stdout.

```bash
lmnr-cli dataset pull [output-path] [options]
```

**Arguments:**
- `[output-path]` - Path to save the data. If not provided, prints to console

**Options:**
- `-n, --name <name>` - Name of the dataset (either name or id must be provided)
- `--id <id>` - ID of the dataset (either name or id must be provided)
- `--output-format <format>` - Output format (`json`, `csv`, `jsonl`). Inferred from file extension if not provided
- `--batch-size <size>` - Batch size for pulling data (default: 100)
- `--limit <limit>` - Limit number of datapoints to pull
- `--offset <offset>` - Offset for pagination (default: 0)

**Examples:**
```bash
lmnr-cli dataset pull output.jsonl -n my-dataset
lmnr-cli dataset pull -n my-dataset --json          # Print to stdout as JSON
lmnr-cli dataset pull output.csv -n my-dataset --limit 50
```

### `dataset create`

Create a new dataset from local input files.

```bash
lmnr-cli dataset create <name> <paths...> [options]
```

**Arguments:**
- `<name>` - Name of the dataset to create
- `<paths...>` - Paths to files or directories containing data to push

**Required Options:**
- `-o, --output-file <file>` - Path to save the pulled data

**Options:**
- `--output-format <format>` - Output format (`json`, `csv`, `jsonl`). Inferred from file extension if not provided
- `-r, --recursive` - Recursively read files in directories
- `--batch-size <size>` - Batch size for pushing/pulling data (default: 100)

**Examples:**
```bash
lmnr-cli dataset create my-dataset data.jsonl -o output.jsonl
lmnr-cli dataset create my-dataset data/ -o output.json -r
```

## Supported File Formats

- **JSONL** (`.jsonl`) - One JSON object per line
- **JSON** (`.json`) - Array of objects
- **CSV** (`.csv`) - Comma-separated values with headers
