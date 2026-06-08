#!/usr/bin/env node

import { errorMessage } from "@lmnr-ai/types";
import { Command } from "commander";

import { version } from "../package.json";
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from "./commands/dataset";
import { handleDebugSessionSetName, handleDebugSessionSummary } from "./commands/debug";
import { handleList } from "./commands/list";
import { handleLogin } from "./commands/login";
import { handleLogout } from "./commands/logout";
import { handleSetup } from "./commands/setup";
import { handleSqlQuery } from "./commands/sql";
import { SQL_SCHEMA_HELP } from "./commands/sql/schema";
import { handleSwitch } from "./commands/switch";
import { handleTraceAppendNote } from "./commands/trace";
import { handleTracesWait } from "./commands/traces";

async function main() {
  const program = new Command();

  program
    .name("lmnr-cli")
    .description("CLI for the Laminar agent observability platform")
    .version(version, "-v, --version", "display version number");

  const datasetsCmd = program
    .command("dataset")
    .description("Manage datasets")
    .option(
      "--project-api-key <key>",
      "Project API key. If not provided, reads from LMNR_PROJECT_API_KEY env variable",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option(
      "--port <port>",
      "Port for the Laminar API. Defaults to 443",
      (val) => parseInt(val, 10),
    )
    .option("--json", "Output structured JSON to stdout");

  // Datasets list command
  datasetsCmd
    .command("list")
    .description("List all datasets")
    .action(async (_options, cmd) => {
      await handleDatasetsList(cmd.optsWithGlobals());
    });

  // Datasets push command
  datasetsCmd
    .command("push")
    .description("Push datapoints to an existing dataset")
    .argument(
      "<paths...>",
      "Paths to files or directories containing data to push",
    )
    .option(
      "-n, --name <name>",
      "Name of the dataset (either name or id must be provided)",
    )
    .option(
      "--id <id>",
      "ID of the dataset (either name or id must be provided)",
    )
    .option("-r, --recursive", "Recursively read files in directories", false)
    .option(
      "--batch-size <size>",
      "Batch size for pushing data",
      (val) => parseInt(val, 10),
      100,
    )
    .action(async (paths: string[], _options, cmd) => {
      await handleDatasetsPush(paths, cmd.optsWithGlobals());
    });

  // Datasets pull command
  datasetsCmd
    .command("pull")
    .description("Pull data from a dataset")
    .argument(
      "[output-path]",
      "Path to save the data. If not provided, prints to console",
    )
    .option(
      "-n, --name <name>",
      "Name of the dataset (either name or id must be provided)",
    )
    .option(
      "--id <id>",
      "ID of the dataset (either name or id must be provided)",
    )
    .option(
      "--output-format <format>",
      "Output format (json, csv, jsonl). Inferred from file extension if not provided",
    )
    .option(
      "--batch-size <size>",
      "Batch size for pulling data",
      (val) => parseInt(val, 10),
      100,
    )
    .option("--limit <limit>", "Limit number of datapoints to pull", (val) =>
      parseInt(val, 10),
    )
    .option(
      "--offset <offset>",
      "Offset for pagination",
      (val) => parseInt(val, 10),
      0,
    )
    .action(async (outputPath: string | undefined, _options, cmd) => {
      await handleDatasetsPull(outputPath, cmd.optsWithGlobals());
    });

  // Datasets create command
  datasetsCmd
    .command("create")
    .description("Create a dataset from input files")
    .argument("<name>", "Name of the dataset to create")
    .argument(
      "<paths...>",
      "Paths to files or directories containing data to push",
    )
    .requiredOption("-o, --output-file <file>", "Path to save the pulled data")
    .option(
      "--output-format <format>",
      "Output format (json, csv, jsonl). Inferred from file extension if not provided",
    )
    .option("-r, --recursive", "Recursively read files in directories", false)
    .option(
      "--batch-size <size>",
      "Batch size for pushing/pulling data",
      (val) => parseInt(val, 10),
      100,
    )
    .action(async (name: string, paths: string[], _options, cmd) => {
      await handleDatasetsCreate(name, paths, cmd.optsWithGlobals());
    });

  const sqlCmd = program
    .command("sql")
    .description("Run SQL queries against your Laminar project data")
    .option(
      "--project-api-key <key>",
      "Project API key. If not provided, reads from LMNR_PROJECT_API_KEY env variable",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option(
      "--port <port>",
      "Port for the Laminar API. Defaults to 443",
      (val) => parseInt(val, 10),
    )
    .option("--json", "Output structured JSON to stdout");

  sqlCmd
    .command("query")
    .description("Execute a SQL query")
    .argument("<query>", "SQL query string")
    .action(async (query: string, _options, cmd) => {
      await handleSqlQuery(query, cmd.optsWithGlobals());
    })
    .addHelpText(
      "after",
      SQL_SCHEMA_HELP +
        `
Examples:
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10"
  $ lmnr-cli sql query "SELECT id, total_cost, status FROM traces LIMIT 20"
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
`,
    );

  sqlCmd
    .command("schema")
    .description("Show available tables and their columns")
    .action(() => {
      process.stdout.write(SQL_SCHEMA_HELP);
    });

  const traceCmd = program
    .command("trace")
    .description("Operate on existing traces")
    .option(
      "--project-api-key <key>",
      "Project API key. If not provided, reads from LMNR_PROJECT_API_KEY env variable",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option(
      "--port <port>",
      "Port for the Laminar API. Defaults to 443",
      (val) => parseInt(val, 10),
    )
    .option("--json", "Output structured JSON to stdout");

  traceCmd
    .command("append-note")
    .description("Append a free-text note to a trace (stored in trace metadata)")
    .argument("<trace-id>", "Trace ID (UUID or 32-char OTel hex trace id)")
    .argument("<note>", "Note text (may contain markdown)")
    .action(async (traceId: string, note: string, _options, cmd) => {
      await handleTraceAppendNote(traceId, note, cmd.optsWithGlobals());
    })
    .addHelpText(
      "after",
      `
Notes accumulate: each call appends a new paragraph to the trace's existing
note rather than overwriting it.

Examples:
  $ lmnr-cli trace append-note <trace-id> "Reproduced the timeout on the search tool."
`,
    );

  const debugCmd = program
    .command("debug")
    .description("Operate on debug sessions")
    .option(
      "--project-api-key <key>",
      "Project API key. If not provided, reads from LMNR_PROJECT_API_KEY env variable",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option(
      "--port <port>",
      "Port for the Laminar API. Defaults to 443",
      (val) => parseInt(val, 10),
    )
    .option("--json", "Output structured JSON to stdout")
    .addHelpText(
      "after",
      `
Learn more about debugging features at https://laminar.sh/docs/platform/debugger
`,
    );

  const debugSessionCmd = debugCmd
    .command("session")
    .description("Manage debug sessions")
    .addHelpText(
      "after",
      `
Learn more about debugging features at https://laminar.sh/docs/platform/debugger
`,
    );

  debugSessionCmd
    .command("set-name")
    .description("Set the display name of a debug session")
    .argument("<session-id>", "Debug session ID")
    .argument("<name>", "Session display name")
    .action(async (sessionId: string, name: string, _options, cmd) => {
      await handleDebugSessionSetName(sessionId, name, cmd.optsWithGlobals());
    })
    .addHelpText(
      "after",
      `
Examples:
  $ lmnr-cli debug session set-name <session-id> "Fix report length + search tool"
`,
    );

  debugSessionCmd
    .command("summary")
    .description("Print every trace in a debug session with its note, oldest first")
    .argument("<session-id>", "Debug session ID")
    .action(async (sessionId: string, _options, cmd) => {
      await handleDebugSessionSummary(sessionId, cmd.optsWithGlobals());
    })
    .addHelpText(
      "after",
      `
Output is one block per trace (oldest first), the trace's note followed by a
self-closing tag carrying the trace id and end time:

  {note}
  <trace id="{trace-id}" end-time="{end-time}"/>

With --json, prints an array of {"note", "traceId", "endTime"} objects.

Examples:
  $ lmnr-cli debug session summary <session-id>
  $ lmnr-cli debug session summary <session-id> --json
`,
    );

  program
    .command("login")
    .description("Authenticate the CLI via OAuth Device Flow")
    .option(
      "--dashboard-url <url>",
      "Dashboard URL (issuer). Defaults to https://www.laminar.sh or LMNR_DASHBOARD_URL env variable",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option("--no-browser", "Do not open the verification URL in a browser")
    .action(async (options) => {
      await handleLogin(options);
    });

  program
    .command("logout")
    .description("Remove a stored login profile. Defaults to the active profile.")
    .argument("[user]", "User email or id to log out of")
    .option("--all", "Remove every stored profile")
    .action(async (user: string | undefined, options: { all?: boolean }) => {
      await handleLogout(user, { all: options.all });
    });

  program
    .command("list")
    .description("List authenticated login profiles")
    .action(async () => {
      await handleList();
    });

  program
    .command("switch <user>")
    .description("Change the active login profile (no re-authentication)")
    .action(async (user: string) => {
      await handleSwitch(user);
    });

  const traces = program
    .command("traces")
    .description("Inspect traces in a project");

  traces
    .command("wait")
    .description("Poll the server until N spans appear in the last <since> window")
    .option("--since <duration>", "Look-back window (e.g. 60s, 2m, 1h)", "60s")
    .option("--count <n>", "Minimum span count", "1")
    .option("--timeout <duration>", "Give up after this duration", "120s")
    .option("--project-api-key <key>", "Override LMNR_PROJECT_API_KEY")
    .option("--json", "Emit a machine-readable JSON line on stdout")
    .option("--base-url <url>", "Base URL for the Laminar API")
    .option("--port <port>", "Port for the Laminar API", (v) => parseInt(v, 10))
    .action(async (options) => {
      await handleTracesWait(options);
    });

  program
    .command("setup")
    .description("One-shot onboarding: login + write LMNR_PROJECT_API_KEY")
    .option("--write-env", "Write LMNR_PROJECT_API_KEY to ./.env (default)", true)
    .option("--no-write-env", "Do not write to ./.env")
    .option("--json", "Emit a machine-readable JSON line on stdout")
    .option("--no-browser", "Do not auto-open the device-flow URL")
    .option(
      "--dashboard-url <url>",
      "Dashboard URL (issuer). Defaults to LMNR_DASHBOARD_URL or https://www.laminar.sh",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to LMNR_BASE_URL or https://api.lmnr.ai",
    )
    .action(async (options) => {
      await handleSetup(options);
    });

  program.addHelpText(
    "after",
    `
Authentication (precedence: highest first):
    1. CLI flag:             --project-api-key <your-key>
    2. Environment variable: export LMNR_PROJECT_API_KEY=<your-key>
    3. OAuth Device Flow:    lmnr-cli login
  Get an API key at https://www.laminar.sh (Settings > Project API Keys),
  or run "lmnr-cli login" to authenticate via your browser.

Examples:
  lmnr-cli setup --json                                    # One-shot onboarding (login + .env)
  lmnr-cli login                                           # Add a project profile
  lmnr-cli list                                            # List authenticated project profiles
  lmnr-cli switch my-prod-project                          # Change the active profile
  lmnr-cli logout                                          # Log out of the active profile
  lmnr-cli logout --all                                    # Remove every stored profile
  lmnr-cli traces wait --since 60s --count 1               # Wait for traces (verifies)
  lmnr-cli dataset list --json                             # List all datasets
  lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
  lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
  lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json # Query spans
  lmnr-cli sql query "SELECT t.id, s.name FROM traces t JOIN spans s ON t.id = s.trace_id" --json
  lmnr-cli sql schema                                      # Show available tables
  lmnr-cli trace append-note <trace-id> "note text"        # Append a note to a trace
  lmnr-cli debug session set-name <session-id> "title"     # Rename a debug session
  lmnr-cli debug session summary <session-id>              # Notes for each trace in a session

For more information about the Laminar platfrom:
  Documentation: https://laminar.sh/docs
  Dashboard:     https://www.laminar.sh
`,
  );

  await program.parseAsync();
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});
