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
import { runDev } from "./commands/dev";
import { handleList } from "./commands/list";
import { handleLogin } from "./commands/login";
import { handleLogout } from "./commands/logout";
import { handleSetup } from "./commands/setup";
import { handleSqlQuery } from "./commands/sql";
import { SQL_SCHEMA_HELP } from "./commands/sql/schema";
import { handleSwitch } from "./commands/switch";
import { handleTracesWait } from "./commands/traces";

async function main() {
  const program = new Command();

  program
    .name("lmnr-cli")
    .description("CLI for the Laminar agent observability platform")
    .version(version, "-v, --version", "display version number");

  program
    .command("dev")
    .description("Start a debugging session")
    .argument(
      "[file]",
      "Path to file containing the entrypoint function(s). Either `file` or `-m` must be provided.",
    )
    .option(
      "-m, --python-module <module>",
      "Python module path (e.g., src.myfile). Either `file` or `-m` must be provided.",
    )
    .option(
      "--function <name>",
      "Specific function to serve (if multiple entrypoint functions found)",
    )
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
    .option(
      "--grpc-port <port>",
      "Port for the Laminar gRPC backend. Defaults to 8443",
      (val) => parseInt(val, 10),
    )
    .option(
      "--frontend-port <port>",
      "Port for the Laminar frontend. Defaults to 5667",
      (val) => parseInt(val, 10),
    )
    .option(
      "--external-packages <packages...>",
      "[ADVANCED] List of packages to pass as external to esbuild. This will not link " +
        "the packages directly into the dev file, but will instead require them at runtime. " +
        "Read more: https://esbuild.github.io/api/#external",
    )
    .option(
      "--dynamic-imports-to-skip <modules...>",
      "[ADVANCED] List of module names to skip when encountered as dynamic imports. " +
        "These dynamic imports will resolve to an empty module to prevent build failures. " +
        "This is meant to skip the imports that are not used in the entrypoint function itself.",
    )
    .option(
      "--command <command>",
      "[ADVANCED] Custom command to run the worker (e.g., python3, node)",
    )
    .option(
      "--command-args <args...>",
      "[ADVANCED] Arguments for the custom command",
    )
    .action(async (file: string | undefined, options) => {
      // Validation: must have either file or python-module, but not both
      if (!file && !options.pythonModule) {
        console.error(
          "Error: Must provide either a file path or --python-module (-m) flag",
        );
        process.exit(1);
      }
      if (file && options.pythonModule) {
        console.error(
          "Error: Cannot specify both file path and --python-module (-m) flag",
        );
        process.exit(1);
      }

      await runDev(file, options);
    })
    .addHelpText(
      "after",
      `
Examples:
  $ lmnr-cli dev agent.ts                    # TypeScript file
  $ lmnr-cli dev agent.py                    # Python file (script mode)
  $ lmnr-cli dev -m src.agent                # Python module (module mode)
  $ lmnr-cli dev agent.ts --function myAgent # Specific function
`,
    );

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
    .description("Remove a stored OAuth profile. Defaults to the active profile.")
    .argument("[project]", "Project id or name to log out of")
    .option("--all", "Remove every stored profile")
    .action(async (project: string | undefined, options: { all?: boolean }) => {
      await handleLogout(project, { all: options.all });
    });

  program
    .command("list")
    .description("List authenticated project profiles")
    .action(async () => {
      await handleList();
    });

  program
    .command("switch <project>")
    .description("Change the active project profile (no re-authentication)")
    .action(async (project: string) => {
      await handleSwitch(project);
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
  lmnr-cli dev agent.ts                                    # Debugger TypeScript entrypoint
  lmnr-cli dev agent.py                                    # Debugger Python script mode
  lmnr-cli dev -m src.agent                                # Debugger Python module mode
  lmnr-cli dataset list --json                             # List all datasets
  lmnr-cli dataset push data.jsonl -n my-dataset --json    # Push data to a dataset
  lmnr-cli dataset pull output.jsonl -n my-dataset --json  # Pull data from a dataset
  lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json # Query spans
  lmnr-cli sql query "SELECT t.id, s.name FROM traces t JOIN spans s ON t.id = s.trace_id" --json
  lmnr-cli sql schema                                      # Show available tables

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
