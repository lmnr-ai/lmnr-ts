# lmnr-cli sql

Run SQL queries against your Laminar project data.

## Usage

```bash
lmnr-cli sql <command> [options]
```

### Global Options

These options apply to all sql subcommands:

- `--project-api-key <key>` - Project API key (or set `LMNR_PROJECT_API_KEY` env variable)
- `--base-url <url>` - Base URL for the Laminar API (default: https://api.lmnr.ai)
- `--port <port>` - Port for the Laminar API (default: 443)
- `--json` - Output structured JSON to stdout

## Commands

### `sql query`

Execute a SQL query against your project data.

```bash
lmnr-cli sql query "<query>" [options]
```

**Examples:**
```bash
lmnr-cli sql query "SELECT * FROM spans LIMIT 10"
lmnr-cli sql query "SELECT id, total_cost, status FROM traces LIMIT 20"
lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
lmnr-cli sql query "SELECT t.id, s.name FROM traces t JOIN spans s ON t.id = s.trace_id" --json
```

### `sql schema`

Show available tables and their columns.

```bash
lmnr-cli sql schema
```

## Available Tables

### `spans`

| Column | Type |
|--------|------|
| span_id | UUID |
| name | String |
| span_type | String (DEFAULT, LLM, TOOL) |
| start_time | DateTime64 |
| end_time | DateTime64 |
| duration | Float64 |
| input_cost | Float64 |
| output_cost | Float64 |
| total_cost | Float64 |
| input_tokens | Int64 |
| output_tokens | Int64 |
| total_tokens | Int64 |
| request_model | String |
| response_model | String |
| model | String |
| trace_id | UUID |
| provider | String |
| path | String |
| input | String |
| output | String |
| status | String |
| parent_span_id | UUID |
| attributes | String |
| tags | Array(String) |

### `traces`

| Column | Type |
|--------|------|
| id | UUID |
| start_time | DateTime64 |
| end_time | DateTime64 |
| input_tokens | Int64 |
| output_tokens | Int64 |
| total_tokens | Int64 |
| input_cost | Float64 |
| output_cost | Float64 |
| total_cost | Float64 |
| duration | Float64 |
| metadata | String |
| session_id | String |
| user_id | String |
| status | String |
| top_span_id | UUID |
| top_span_name | String |
| top_span_type | String |
| trace_type | String |
| tags | Array(String) |
| has_browser_session | Bool |

### `events`

| Column | Type |
|--------|------|
| id | UUID |
| type | String |
| name | String |
| span_id | UUID |
| timestamp | DateTime64 |
| attributes | String |

### `signal_events`

| Column | Type |
|--------|------|
| id | UUID |
| signal_id | UUID |
| trace_id | UUID |
| run_id | UUID |
| name | String |
| payload | String |
| timestamp | DateTime64 |

### `signal_runs`

| Column | Type |
|--------|------|
| signal_id | UUID |
| job_id | UUID |
| trigger_id | UUID |
| run_id | UUID |
| trace_id | UUID |
| status | String |
| event_id | UUID |
| updated_at | DateTime64 |

### `evaluation_datapoints`

| Column | Type |
|--------|------|
| id | UUID |
| evaluation_id | UUID |
| data | String |
| target | String |
| metadata | String |
| executor_output | String |
| index | UInt64 |
| trace_id | UUID |
| group_id | String |
| scores | String |
| created_at | DateTime64 |
| dataset_id | UUID |
| dataset_datapoint_id | UUID |
| dataset_datapoint_created_at | DateTime64 |

### `dataset_datapoints`

| Column | Type |
|--------|------|
| id | UUID |
| created_at | DateTime64 |
| dataset_id | UUID |
| data | String |
| target | String |
| metadata | String |
