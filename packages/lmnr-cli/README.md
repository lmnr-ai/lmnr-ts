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
Project commands (`sql`, `dataset`, `trace`, `debug`) run on that user session
and target a project via `--project-id` or the `.lmnr/project.json` link written
by `lmnr-cli setup`.

The project API key that `setup` writes to `./.env` (`LMNR_PROJECT_API_KEY`) is
for your **application's SDK** (trace ingestion). The CLI commands that read
it are the `eval` ones: local `eval run`s report results with it, and `eval
run --remote`, `eval dataset push` and `eval dataset pull` use it when there is
no login (e.g. in CI).

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

Create, inspect, rename, delete, and transfer dataset datapoints.

```bash
lmnr-cli dataset list --json                              # List all datasets
lmnr-cli dataset get <dataset-id> --json                  # Get by canonical UUID
lmnr-cli dataset update <dataset-id> --name renamed       # Rename by UUID
lmnr-cli dataset delete <dataset-id> --json               # Delete without prompting
lmnr-cli dataset create my-dataset data.jsonl -o out.jsonl
```

### `debug` - Annotate and inspect agent runs

Record findings on a debug session and review/name agent debug sessions.

```bash
lmnr-cli debug session new                               # Mint a fresh debug session
lmnr-cli debug session open                              # Open the session in the browser
lmnr-cli debug session add-note "note text"              # Markdown note on the current session
lmnr-cli debug session set-name "title"                  # Rename the current debug session
lmnr-cli debug session summary                           # Every block in the session, oldest first
```

These commands default to the session recorded in
`.lmnr/debug-session.json` (written by `debug session new` and any `LMNR_DEBUG=1`
run — including evals; the nearest one walking up from the current directory, so
subdirectories of a project work too); target another one with
`--session-id <session-id>`.

`debug session add-note` writes a standalone text block keyed by session id (not
tied to a trace or evaluation), so it works the same for agent runs and evals
(any `LMNR_DEBUG=1` program). Each call appends a new block, interleaved by time
with the session's traces and evaluations. See the Laminar debugger docs:
https://laminar.sh/docs/platform/debugger

### `eval` - Harbor evals and eval datasets

An evals folder (default `evals`, `--dir` to change) holds one folder per
**eval dataset**, named after it:

```
evals/
  .gitignore       # */tasks/ (written by the CLI): tasks live in Laminar
  support/
    harbor.yaml    # Harbor JobConfig, without `datasets` / `tasks`
    lmnr.yaml      # optional: images tasks use (paths relative to this folder)
    agent/ ...     # your agent, Dockerfiles, scripts
    tasks/         # Harbor tasks, filled by `eval dataset pull` (gitignored)
    tasks.toml     # the pinned version of each task; commit it
```

The setup (harbor.yaml, agent, Dockerfiles) stays in your repo; the tasks live
in Laminar. Each task is versioned on its own by the content hash of its
folder, and `tasks.toml` pins one version per task:

```toml
[tasks]
refund = "5fc5d83e2db1dd8cbc6c508e273fbd9604fc38d743443435755405a7ce91809d"
customer-complaint = "e82b0240004c2fae7c87f0430211ef4652ce1dc15ad1efa8c8bdfb8f0b71a7e0"
```

```bash
lmnr-cli eval dataset push                     # version new / changed tasks, update tasks.toml
lmnr-cli eval dataset push support --dry-run   # what would be added / changed / removed
lmnr-cli eval dataset pull                     # make tasks/ match tasks.toml (fresh clone, git pull)
lmnr-cli eval dataset pull support --latest    # pin and get the latest version of every task
lmnr-cli eval run                              # every dataset, trials on local Docker
lmnr-cli eval run support --task "refund-*"
lmnr-cli eval run --remote                     # in Laminar sandboxes
```

`eval dataset pull` refuses to overwrite or delete tasks edited since their
last pull or push unless `--force`; pulled tasks are cached in
`$LMNR_CACHE_DIR`, `$XDG_CACHE_HOME/lmnr` or `~/.cache/lmnr`. `eval dataset
push` refuses to push tasks that are older than `tasks.toml` pins: unedited
ones (pull first), and edits that started from a version older than the pin
(they would drop the newer one). Both take `--task <glob>`, `--dry-run` and `--json`.

`eval run` reports every trial to Laminar as an evaluation grouped by dataset
name, with the version of its task. Pinned tasks missing from `tasks/`, or
unedited and older than `tasks.toml` pins, are pulled first; edited tasks run
as they are (it warns).

`--remote` prints the run's log until it ends; Ctrl-C stops following and
leaves the run going. Tasks whose version is in Laminar already aren't
uploaded with the run: it gets them from Laminar.

Both run modes need Docker; local runs also need [uv](https://docs.astral.sh/uv/)
and `LMNR_PROJECT_API_KEY`. `--remote` pushes
the images tasks use from your local Docker. See `lmnr-cli eval run --help` for
images (`lmnr.yaml`), secrets and flags. Exit codes:

- `16` invalid evals folder (including a harbor.yaml that sets `datasets` or
  `tasks`, a root `evals/lmnr.yaml` or a broken `tasks.toml`), or an upload
  over its size limit
- `17` `uv` or `docker` is not installed
- `18` a dataset's `harbor run` failed
- `19` an unset `${VAR}` placeholder or `LMNR_PROJECT_API_KEY`
- `20` a Docker build, pull or save failed, or an image isn't linux/amd64
- `21` a `--remote` run failed before its datasets ran, or its sandbox was lost
- `22` `eval dataset pull` would overwrite local edits in `tasks/` (push them,
  or `--force`)
- `23` `eval dataset push` of a task whose pin moved since it was pulled here,
  edited or not: `tasks.toml` pins another version, or a newer version was
  pushed to Laminar. Pull (`--latest` for a version only Laminar has,
  `--force` to drop edits after copying them aside), re-apply any edits, push
  again
- `24` the eval dataset or a task version isn't in Laminar

With `--json`, errors are `{"error": "<message>", "code": "<code>"}` on stdout.

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

### `skill` - Laminar agent skill

Install or update the Laminar agent skill (the same one `setup` installs)
without re-running onboarding. Local-only: no login needed.

```bash
lmnr-cli skill add                          # Install into present agent dirs
lmnr-cli skill update                       # Replace every installed copy with the latest
```

`skill add` writes the skill into `skills/laminar/` under every present agent
dir (`.claude`, `.cursor`, `.codex`, `.agents`), defaulting to `.claude/` +
`.agents/` when none exist. `skill update` only replaces copies that are
already installed. Both accept `--json`.

### `plugin` - Agent observability plugins

Install Laminar tracing hooks/plugins for coding agents. This is global and does
not touch `.lmnr/project.json` or `.env`.

```bash
lmnr-cli plugin add claude-code             # Claude Code plugin marketplace install
lmnr-cli plugin add codex                   # Codex plugin marketplace install
lmnr-cli plugin add codex --project-id <uuid>
lmnr-cli plugin add codex --print-only      # Show equivalent manual steps
```

The command logs in if needed, lets you pick a project, mints a plugin-named
project API key, and writes it to `~/.config/lmnr/<agent>-plugin.json`, which
the plugin reads.

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
