#!/usr/bin/env node

import { errorMessage } from "@lmnr-ai/types";
import { Command } from "commander";

import { version } from "../package.json";
import { withLocalOpts, withProjectClient, withUserToken } from "./auth/with-client";
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from "./commands/dataset";
import {
  handleDebugSessionNew,
  handleDebugSessionOpen,
  handleDebugSessionSetName,
  handleDebugSessionSummary,
} from "./commands/debug";
import { handleLogin } from "./commands/login";
import { handleLogout } from "./commands/logout";
import { handleProjectsList } from "./commands/project";
import { handleSetup } from "./commands/setup";
import { handleSqlQuery } from "./commands/sql";
import { SQL_SCHEMA_HELP } from "./commands/sql/schema";
import { handleTraceAppendNote } from "./commands/trace";
import { pc } from "./utils/colors";
import { loadLocalEnv } from "./utils/env-file";

async function main() {
  // Hydrate LMNR_* config from a project .env(.local) before anything reads it
  // (login/setup/resolve read process.env at command-execution time, which is
  // after this). Runners like Claude Code don't inject .env into the subprocess
  // env, so this is how a local self-host config gets picked up.
  await loadLocalEnv(process.cwd());

  const program = new Command();

  program
    .name("lmnr-cli")
    .description("CLI for the Laminar agent observability platform")
    .version(version, "-v, --version", "display version number");

  const datasetsCmd = program
    .command("dataset")
    .description("Manage datasets")
    .option(
      "--project-id <id>",
      "Target project id. Defaults to the linked .lmnr/project.json. " +
      "Run `lmnr-cli login` first.",
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
    .action(withProjectClient(handleDatasetsList));

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
    .action(withProjectClient(handleDatasetsPush));

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
    .action(withProjectClient(handleDatasetsPull));

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
    .action(withProjectClient(handleDatasetsCreate));

  const sqlCmd = program
    .command("sql")
    .description("Run SQL queries against your Laminar project data")
    .option(
      "--project-id <id>",
      "Target project id. Defaults to the linked .lmnr/project.json. " +
      "Run `lmnr-cli login` first.",
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
    .action(withProjectClient(handleSqlQuery))
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

  const projectCmd = program.command("project").description("Work with Laminar projects");

  projectCmd
    .command("list")
    .description("List the projects you can access (● = linked to this directory)")
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to the logged-in session or LMNR_BASE_URL",
    )
    .option(
      "--port <port>",
      "Port for the Laminar API. Defaults to 443",
      (val) => parseInt(val, 10),
    )
    .option("--json", "Output structured JSON to stdout")
    .action(withUserToken(handleProjectsList));

  program
    .command("login")
    .description("Authenticate the CLI via OAuth Device Flow")
    .option(
      "--frontend-url <url>",
      "Frontend URL (issuer). Defaults to https://laminar.sh or LMNR_FRONTEND_URL env variable",
    )
    .option("--no-browser", "Do not open the verification URL in a browser")
    .action(async (options) => {
      const result = await handleLogin(options);
      process.stderr.write(`${pc.green("✓")} Logged in as ${result.userEmail ?? "<unknown>"}.\n`);
      process.stderr.write(
        pc.dim("Client: lmnr-cli. Tokens stored at ~/.config/lmnr/credentials.json (mode 0600).\n"),
      );
      process.stderr.write(
        pc.dim("Run `lmnr-cli setup` in a project directory to link it and write its API key.\n"),
      );
    });

  program
    .command("logout")
    .description("Log out and remove the stored credentials")
    .action(async () => {
      await handleLogout();
    });

  program
    .command("setup")
    .description(
      "One-shot onboarding: login, select a project, write its key to .env, " +
      "link .lmnr, and install the Laminar agent skill",
    )
    .option("--write-env", "Write LMNR_PROJECT_API_KEY to ./.env (default)", true)
    .option("--no-write-env", "Do not write to ./.env")
    .option(
      "--project-id <id>",
      "Project to link when you can access more than one (disambiguates the " +
      "project_ambiguous case in --json mode)",
    )
    .option("--json", "Emit a machine-readable JSON line on stdout")
    .option("--no-browser", "Do not auto-open the device-flow URL")
    .option(
      "--frontend-url <url>",
      "Frontend URL (issuer). Defaults to LMNR_FRONTEND_URL or https://laminar.sh",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to LMNR_BASE_URL or https://api.lmnr.ai",
    )
    .action(async (options) => {
      await handleSetup(options);
    });

  const traceCmd = program
    .command("trace")
    .description("Inspect and operate on traces")
    .option(
      "--project-id <id>",
      "Target project id. Defaults to the linked .lmnr/project.json. " +
      "Run `lmnr-cli login` first.",
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
    .argument("<note>", "Note text (may contain markdown)")
    .option(
      "--trace-id <id>",
      "Trace ID (UUID or 32-char OTel hex trace id). Defaults to the trace_id " +
      "of .lmnr/debug-session.json (the most recent debug run here)",
    )
    .action(withProjectClient(handleTraceAppendNote))
    .addHelpText(
      "after",
      `
Notes accumulate: each call appends a new paragraph to the trace's existing
note rather than overwriting it.

Without --trace-id, the note goes to the trace_id recorded in
.lmnr/debug-session.json — the root trace of the most recent LMNR_DEBUG=1 run
in this directory.

Examples:
  $ lmnr-cli trace append-note "Reproduced the timeout on the search tool."
  $ lmnr-cli trace append-note "Reproduced the timeout." --trace-id <trace-id>
`,
    );

  const debugCmd = program
    .command("debug")
    .description("Operate on debug sessions")
    .option(
      "--project-id <id>",
      "Target project id. Defaults to the linked .lmnr/project.json. " +
      "Run `lmnr-cli login` first.",
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
    .argument("<name>", "Session display name")
    .option(
      "--session-id <id>",
      "Debug session ID. Defaults to the session in .lmnr/debug-session.json",
    )
    .action(withProjectClient(handleDebugSessionSetName))
    .addHelpText(
      "after",
      `
Without --session-id, the name applies to the session recorded in
.lmnr/debug-session.json (written by \`debug session new\` / LMNR_DEBUG=1 runs).

Examples:
  $ lmnr-cli debug session set-name "Fix report length + search tool"
  $ lmnr-cli debug session set-name "Fix report length" --session-id <session-id>
`,
    );

  debugSessionCmd
    .command("summary")
    .description("Print every trace in a debug session with its note, oldest first")
    .option(
      "--session-id <id>",
      "Debug session ID. Defaults to the session in .lmnr/debug-session.json",
    )
    .action(withProjectClient(handleDebugSessionSummary))
    .addHelpText(
      "after",
      `
Without --session-id, summarizes the session recorded in
.lmnr/debug-session.json (written by \`debug session new\` / LMNR_DEBUG=1 runs).

Output is one block per trace (oldest first), the trace's note followed by a
self-closing tag carrying the trace id and end time:

  {note}
  <trace id="{trace-id}" end-time="{end-time}"/>

With --json, prints an array of {"note", "traceId", "endTime"} objects.

Examples:
  $ lmnr-cli debug session summary
  $ lmnr-cli debug session summary --session-id <session-id> --json
`,
    );

  debugSessionCmd
    .command("open")
    .description("Open a debug session's debugger page in the browser")
    .option(
      "--session-id <id>",
      "Debug session ID. Defaults to the session in .lmnr/debug-session.json",
    )
    .action(withLocalOpts(handleDebugSessionOpen))
    .addHelpText(
      "after",
      `
Without --session-id, opens the session recorded in .lmnr/debug-session.json
(written by \`debug session new\` / LMNR_DEBUG=1 runs). The URL is also printed
to stdout; in --json mode a {"sessionId","debuggerUrl"} object is printed
instead. Local-only: no login or network needed.

Examples:
  $ lmnr-cli debug session open
  $ lmnr-cli debug session open --session-id <session-id>
`,
    );

  debugSessionCmd
    .command("new")
    .description("Create a fresh debug session and reset .lmnr/debug-session.json")
    .option("--no-browser", "Do not open the debugger session URL in a browser")
    .action(withProjectClient(handleDebugSessionNew))
    .addHelpText(
      "after",
      `
Mints a new session id, writes it to .lmnr/debug-session.json (resetting any
prior session), and registers it with the backend. The next \`LMNR_DEBUG=1 <run>\`
in this directory rejoins this session silently (no browser).

The bare session id is printed to stdout; in --json mode a
{"sessionId","projectId","debuggerUrl"} object is printed instead.

Examples:
  $ lmnr-cli debug session new
  $ lmnr-cli debug session new --json
  $ lmnr-cli debug session new --no-browser
`,
    );

  program.addHelpText(
    "after",
    `
Authentication:
  Run \`lmnr-cli setup\` to login, link this directory, write a project API key to
  ./.env, and install the Laminar skill 
  \`lmnr-cli login\` authenticates as a user. Every project command
  (sql / dataset / project / trace / debug) runs on that user session and
  targets a project via --project-id or the linked .lmnr/project.json.

Examples:
  lmnr-cli setup                                           # Logs in and prepares directory
  lmnr-cli login                                           # Authenticate (user)
  lmnr-cli project list                                    # Projects you can access
  lmnr-cli logout                                          # Log out
  lmnr-cli dataset list --json                             # List all datasets
  lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
  lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
  lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json # Query spans
  lmnr-cli sql schema                                      # Show available tables
  lmnr-cli trace append-note "note text"                   # Note on the latest debug trace
  lmnr-cli debug session new                               # Mint a fresh debug session
  lmnr-cli debug session open                              # Open the session in the browser
  lmnr-cli debug session set-name "title"                  # Rename the current debug session
  lmnr-cli debug session summary                           # Notes for each trace in the session

For more information about the Laminar platfrom:
  Documentation: https://laminar.sh/docs
`,
  );

  await program.parseAsync();
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});
