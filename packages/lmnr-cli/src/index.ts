#!/usr/bin/env node

import { errorMessage } from "@lmnr-ai/types";
import { Command } from "commander";

import { version } from "../package.json";
import { withLocalOpts, withProjectClient, withUserToken } from "./auth/with-client";
import { handleAsk } from "./commands/ask";
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from "./commands/dataset";
import {
  handleDebugSessionAddNote,
  handleDebugSessionNew,
  handleDebugSessionOpen,
  handleDebugSessionSetName,
  handleDebugSessionSummary,
} from "./commands/debug";
import { handleLogin } from "./commands/login";
import { handleLogout } from "./commands/logout";
import { handlePluginAdd } from "./commands/plugin";
import { handleProjectsList } from "./commands/project";
import { handleProjectLink } from "./commands/project/link";
import { handleProjectMintKey } from "./commands/project/mint-key";
import { handleSetup } from "./commands/setup";
import { handleSkillAdd, handleSkillUpdate } from "./commands/skill";
import { handleSqlQuery } from "./commands/sql";
import { SQL_SCHEMA_HELP } from "./commands/sql/schema";
import { handleStatus } from "./commands/status";
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

  // Auto-tracking of investigative commands (sql query / ask) into the active
  // debug session lives in the command error envelope (`runWithEnvelope` in
  // auth/with-client.ts), NOT a Commander hook: the envelope is the only place
  // that sees both success AND failure with the real exit code (Commander has no
  // on-error hook). See `maybeTrackCommand`.

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
    .option(
      "--no-track",
      "Do not record this command into the active debug session " +
      "(also: LMNR_NO_COMMAND_TRACKING=1)",
    )
    .action(withProjectClient(handleSqlQuery))
    .addHelpText(
      "after",
      SQL_SCHEMA_HELP +
      `
When a debug session is active in this directory, the command (and its args) is
recorded into that session as a \`command\` block so a reviewer sees what ran.
The raw query string is uploaded. Disable with --no-track or
LMNR_NO_COMMAND_TRACKING=1.

Examples:
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10"
  $ lmnr-cli sql query "SELECT id, total_cost, status FROM traces LIMIT 20"
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --no-track
`,
    );

  sqlCmd
    .command("schema")
    .description("Show available tables and their columns")
    .action(() => {
      process.stdout.write(SQL_SCHEMA_HELP);
    });

  program
    .command("ask")
    .description("Ask the Laminar agent a natural-language question about your project")
    .argument("<query>", "Natural-language question")
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
    .option(
      "--conversation <id>",
      "Continue a previous conversation by its id (printed after each answer in human mode, " +
      "or in the `--json` output as `conversationId`)",
    )
    .option("--json", "Output structured JSON ({ answer, conversationId, tools }) to stdout")
    .option(
      "--no-track",
      "Do not record this command into the active debug session " +
      "(also: LMNR_NO_COMMAND_TRACKING=1)",
    )
    .action(withLocalOpts(handleAsk))
    .addHelpText(
      "after",
      `
Runs on your logged-in user session (\`lmnr-cli login\`) and targets a project via
--project-id or the linked .lmnr/project.json. The agent answers from your
project's traces/spans/evals via read-only SQL and trace inspection.

When a debug session is active in this directory, the command (and its args) is
recorded into that session as a \`command\` block. The raw question is uploaded.
Disable with --no-track or LMNR_NO_COMMAND_TRACKING=1.

Examples:
  $ lmnr-cli ask "why did my latest trace fail?"
  $ lmnr-cli ask "how many traces errored in the last day?"
  $ lmnr-cli ask "summarize the most expensive trace today" --json
  $ lmnr-cli ask "and which model did it use?" --conversation <id>
  $ lmnr-cli ask "why did my latest trace fail?" --no-track
`,
    );

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

  projectCmd
    .command("link")
    .description("Re-point this directory to a project (rewrites .lmnr/project.json)")
    .option(
      "--project-id <id>",
      "Project to link. Omit to open the interactive (alphabetically sorted) picker",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option("--no-write-env", "Do not write LMNR_PROJECT_API_KEY to ./.env")
    .option("--json", "Emit a machine-readable JSON line ({ projectId, ... }) on stdout")
    .action(async (options) => {
      await handleProjectLink(options);
    })
    .addHelpText(
      "after",
      `
Re-binds the current directory to a project by rewriting .lmnr/project.json,
then ensures a Project API Key for the new project (probes an existing
LMNR_PROJECT_API_KEY, mints + writes one only when needed). If a valid key for a
DIFFERENT project is present it is never clobbered — the re-link still succeeds
and you're pointed at \`lmnr-cli project mint-key\` to mint + paste a new one.
Requires an existing login (\`lmnr-cli login\`); it does NOT open a browser.

Examples:
  $ lmnr-cli project link
  $ lmnr-cli project link --project-id <id>
  $ lmnr-cli project link --project-id <id> --json
  $ lmnr-cli project link --no-write-env
`,
    );

  projectCmd
    .command("mint-key")
    .description("Mint a fresh Project API Key for the linked project and print it")
    .option(
      "--project-id <id>",
      "Project to mint for. Defaults to the linked .lmnr/project.json",
    )
    .option("--json", "Emit { projectId, apiKey, apiKeyId } as JSON on stdout")
    .action(async (options) => {
      await handleProjectMintKey(options);
    })
    .addHelpText(
      "after",
      `
Mints a NEW key each run (find/revoke keys in the dashboard) and PRINTS it — it
does not write .env. The bare key goes to stdout so you can pipe or copy it;
paste it into your environment as LMNR_PROJECT_API_KEY. Requires an existing
login (\`lmnr-cli login\`).

Examples:
  $ lmnr-cli project mint-key
  $ lmnr-cli project mint-key --project-id <id>
  $ export LMNR_PROJECT_API_KEY="$(lmnr-cli project mint-key)"
  $ lmnr-cli project mint-key --json
`,
    );

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
    .command("status")
    .description("Show the signed-in user, linked project, and active debug session")
    .option("--json", "Output a single flat JSON object to stdout")
    .action(withLocalOpts(handleStatus))
    .addHelpText(
      "after",
      `
Reads everything from local state (credentials.json, .lmnr/project.json,
.lmnr/debug-session.json), so it works offline and makes no API call. Missing
pieces render as "not set" lines rather than errors.

The debug session's display NAME is intentionally not shown: it isn't stored
locally and there's no endpoint to read it back yet — status shows the session
id + debugger URL only.

Examples:
  $ lmnr-cli status
  $ lmnr-cli status --json
`,
    );

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

  const skillCmd = program
    .command("skill")
    .description("Manage the Laminar agent skill in this directory")
    .option("--json", "Output structured JSON to stdout");

  skillCmd
    .command("add")
    .description("Install the Laminar agent skill into this directory's agent dirs")
    .action(withLocalOpts(handleSkillAdd))
    .addHelpText(
      "after",
      `
Fetches the latest Laminar skill and writes it into skills/laminar/ under every
present agent dir (.claude, .cursor, .codex, .agents). When none exist, it is
written into both .claude/ and .agents/. Re-running replaces the installed copy.
Local-only: no login needed.

Examples:
  $ lmnr-cli skill add
  $ lmnr-cli skill add --json
`,
    );

  skillCmd
    .command("update")
    .description("Replace every installed Laminar agent skill with the latest version")
    .action(withLocalOpts(handleSkillUpdate))
    .addHelpText(
      "after",
      `
Fetches the latest Laminar skill and replaces every installed copy
(<agent dir>/skills/laminar) under this directory. Fails when no copy is
installed — use \`lmnr-cli skill add\` for a first install. Local-only: no
login needed.

Examples:
  $ lmnr-cli skill update
  $ lmnr-cli skill update --json
`,
    );

  const pluginCmd = program
    .command("plugin")
    .description("Set up the Laminar plugin for a coding agent");

  pluginCmd
    .command("add")
    .description(
      "Log in, pick a project, mint a key, and install the Laminar plugin for a coding agent",
    )
    .argument("<agent>", "Which agent to set up (currently: claude-code, codex)")
    .option(
      "--project-id <id>",
      "Project to send this agent's traces to (skips the interactive picker)",
    )
    .option("--print-only", "Print the install commands instead of running them")
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
    .action(async (agent: string, options) => {
      await handlePluginAdd(agent, options);
    })
    .addHelpText(
      "after",
      `
Global, directory-independent setup: it does NOT touch .lmnr/project.json or
.env. The minted key is named after the plugin (find/revoke it in the dashboard)
and written to ~/.config/lmnr/<agent>-plugin.json, where the plugin reads it. The
plugin is installed via the agent's native plugin marketplace. Restart the agent
after install to activate it.

When the host CLI isn't found (or has no plugin support), or with --print-only,
the install commands are printed for you to run by hand.

Examples:
  $ lmnr-cli plugin add claude-code
  $ lmnr-cli plugin add codex
  $ lmnr-cli plugin add codex --project-id <id>
  $ lmnr-cli plugin add claude-code --print-only
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
    .command("add-note")
    .description("Attach a free-text note to a debug session (a standalone text block)")
    .argument("<note>", "Note text (may contain markdown)")
    .option(
      "--session-id <id>",
      "Debug session ID. Defaults to the session in .lmnr/debug-session.json",
    )
    .action(withProjectClient(handleDebugSessionAddNote))
    .addHelpText(
      "after",
      `
The note is stored as a standalone text block on the session (not on any trace
or evaluation), keyed by session id. Each call appends a new block, interleaved
by time with the session's traces / evals. Works for any LMNR_DEBUG=1 run,
including evaluations — all of them keep .lmnr/debug-session.json pointed at the
current session.

Without --session-id, the note goes to the session recorded in
.lmnr/debug-session.json (written by \`debug session new\` or any LMNR_DEBUG=1
run, including evals).

Examples:
  $ lmnr-cli debug session add-note "Reproduced the timeout on the search tool."
  $ lmnr-cli debug session add-note "Fixed after bumping the timeout." --session-id <session-id>
`,
    );

  debugSessionCmd
    .command("summary")
    .description("Print every block in a debug session (traces, evals, notes), oldest first")
    .option(
      "--session-id <id>",
      "Debug session ID. Defaults to the session in .lmnr/debug-session.json",
    )
    .action(withProjectClient(handleDebugSessionSummary))
    .addHelpText(
      "after",
      `
Without --session-id, summarizes the session recorded in
.lmnr/debug-session.json (written by \`debug session new\` or any LMNR_DEBUG=1
run, including evals).

Output is one entry per block (oldest first): traces and evaluations as
self-closing tags, text notes as their raw markdown:

  <trace id="{trace-id}"/>
  {note}
  <evaluation id="{evaluation-id}"/>

With --json, prints an array of {"id", "createdAt", "type", "content"} blocks.

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
  (sql / dataset / project / debug) runs on that user session and
  targets a project via --project-id or the linked .lmnr/project.json.

Examples:
  lmnr-cli setup                                           # Logs in and prepares directory
  lmnr-cli login                                           # Authenticate (user)
  lmnr-cli project list                                    # Projects you can access
  lmnr-cli project link                                    # Re-point this directory to a project
  lmnr-cli project mint-key                                     # Mint + print a Project API Key
  lmnr-cli logout                                          # Log out
  lmnr-cli status                                          # Show user, project, and debug session
  lmnr-cli dataset list --json                             # List all datasets
  lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
  lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
  lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json # Query spans
  lmnr-cli sql schema                                      # Show available tables
  lmnr-cli debug session new                               # Mint a fresh debug session
  lmnr-cli debug session open                              # Open the session in the browser
  lmnr-cli debug session set-name "title"                  # Rename the current debug session
  lmnr-cli debug session add-note "note text"              # Add a note to the current session
  lmnr-cli debug session summary                           # All blocks in the session, oldest first
  lmnr-cli skill add                                       # Install the Laminar agent skill
  lmnr-cli skill update                                    # Update installed Laminar skills
  lmnr-cli plugin add claude-code                          # Install the Claude Code plugin
  lmnr-cli plugin add codex                                # Install the Codex plugin

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
