#!/usr/bin/env node

import { errorMessage } from "@lmnr-ai/types";
import { Command } from "commander";

import { version } from "../package.json";
import {
  withLocalOpts,
  withProjectClient,
  withUserToken,
} from "./auth/with-client";
import { handleAsk } from "./commands/ask";
import {
  handleDatasetCreate,
  handleDatasetDelete,
  handleDatasetGet,
  handleDatasetsImport,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
  handleDatasetUpdate,
} from "./commands/dataset";
import {
  handleDebugSessionAddNote,
  handleDebugSessionNew,
  handleDebugSessionOpen,
  handleDebugSessionSetName,
  handleDebugSessionSummary,
} from "./commands/debug";
import {
  handleLlmProfileCreate,
  handleLlmProfileDelete,
  handleLlmProfileGet,
  handleLlmProfileList,
  handleLlmProfileUpdate,
} from "./commands/llm-profile";
import { handleLogin } from "./commands/login";
import { handleLogout } from "./commands/logout";
import { AGENTS, handlePluginAdd } from "./commands/plugin";
import { handleProjectsList } from "./commands/project";
import { handleProjectLink } from "./commands/project/link";
import { handleProjectMintKey } from "./commands/project/mint-key";
import { handleSetup } from "./commands/setup";
import {
  handleSignalCreate,
  handleSignalDelete,
  handleSignalGet,
  handleSignalList,
  handleSignalUpdate,
} from "./commands/signal";
import { collectFlag } from "./commands/signal/validate";
import { handleSkillAdd, handleSkillUpdate } from "./commands/skill";
import { handleSqlQuery } from "./commands/sql";
import { handleSqlSchema } from "./commands/sql/schema";
import { handleStatus } from "./commands/status";
import { pc } from "./utils/colors";
import { loadLocalEnv } from "./utils/env-file";
import { withTrackingOptions } from "./utils/track-command";

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

  // Command tracking runs in runWithEnvelope (auth/with-client.ts), not a
  // Commander hook — it's the only place that sees both success and failure with
  // the real exit code. See `maybeTrackCommand`.

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

  datasetsCmd
    .command("get")
    .description("Get a dataset by ID")
    .argument("<dataset-id>", "Dataset UUID")
    .action(withProjectClient(handleDatasetGet));

  datasetsCmd
    .command("create")
    .description("Create an empty dataset")
    .argument("<name>", "Name of the dataset to create")
    .action(withProjectClient(handleDatasetCreate));

  datasetsCmd
    .command("update")
    .description("Rename a dataset")
    .argument("<dataset-id>", "Dataset UUID")
    .requiredOption("-n, --name <name>", "New dataset name")
    .action(withProjectClient(handleDatasetUpdate));

  datasetsCmd
    .command("delete")
    .description("Delete a dataset and its datapoints")
    .argument("<dataset-id>", "Dataset UUID")
    .action(withProjectClient(handleDatasetDelete));

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

  // Dataset import command
  datasetsCmd
    .command("import")
    .description("Create and populate a dataset from input files")
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
    .action(withProjectClient(handleDatasetsImport));

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
    .option("--json", "Output structured JSON to stdout")
    .option(
      "--pretty",
      "Render results as a human-readable table (default is CSV to stdout)",
    );

  const sqlQueryCmd = sqlCmd
    .command("query")
    .description("Execute a SQL query")
    .argument("<query>", "SQL query string");
  withTrackingOptions(sqlQueryCmd)
    .action(withProjectClient(handleSqlQuery))
    .addHelpText(
      "after",
      `
Run \`lmnr-cli sql schema\` for the tables and columns you can query. The
schema is served by the API, so it always matches the running server.

When a debug session is active in this directory, the command (and its args) is
recorded into that session as a \`command\` block so a reviewer sees what ran.
The raw query string is uploaded. Attach agent reasoning with --reasoning.
Disable recording with --no-track or LMNR_NO_COMMAND_TRACKING=1.

Output defaults to CSV on stdout (one record per line, agent-parseable). Use
--json for a JSON array, or --pretty for a human-readable table.

Examples:
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10"
  $ lmnr-cli sql query "SELECT id, total_cost, status FROM traces LIMIT 20"
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --json
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --pretty
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --reasoning "checking error rate"
  $ lmnr-cli sql query "SELECT * FROM spans LIMIT 10" --no-track
`,
    );

  sqlCmd
    .command("schema")
    .description("Show available tables and their columns")
    .action(withProjectClient(handleSqlSchema))
    .addHelpText(
      "after",
      `
Fetched from the API, so it reflects the server you are pointed at rather than
a copy bundled with this CLI. Requires login and network access.

Use --json for the raw payload ({ tables, enums }), which is easier to parse
than the default text rendering.

Examples:
  $ lmnr-cli sql schema
  $ lmnr-cli sql schema --json
`,
    );

  const signalCmd = program
    .command("signal")
    .alias("signals")
    .description("Manage Signals (LLM analyzers that run on matching traces)")
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

  const TRIGGER_HELP = `
Three separate things decide when a signal runs:

  --trigger   WHEN it is evaluated (one choice):
                root-span-finished   the trace's root span finished (default)
                span-name            a named span finished — pass --span-name
                                     (repeatable); for distributed traces where
                                     no single span is observably the root

  --filter    WHETHER it runs, given it fired. JSON object, repeatable, ANDed:
                '{"column":"<col>","operator":"<op>","value":<value>}'
              Properties of the whole trace:
                total_token_count  eq|ne|gt|gte|lt|lte  <number>
                status             eq | ne              error | success
                span_names         eq (include) | ne (do not include)  <name>
              No filters means it runs on every trace it fires for.

  --mode      HOW it runs: batch or realtime. Omitted → realtime.

Note --span-name (the TRIGGER, matched in the firing batch) and the span_names
FILTER (matched anywhere in the trace) are different things.
`;

  signalCmd
    .command("list")
    .description("List signals in the project")
    .argument("[name]", "Filter by name (case-insensitive substring)")
    .action(withProjectClient(handleSignalList));

  signalCmd
    .command("get")
    .description("Show one signal with its trigger, filters, and mode")
    .argument("<signal>", "Signal id or name")
    .action(withProjectClient(handleSignalGet));

  signalCmd
    .command("create")
    .description("Create a signal with a payload schema, trigger, and filters")
    .argument("<name>", "Signal name (unique per project, max 255 chars)")
    .requiredOption(
      "--prompt <prompt>",
      "LLM instruction describing what to detect in a trace",
    )
    .requiredOption(
      "--schema <json>",
      "Payload schema as JSON: " +
        '\'{"properties":{"<field>":{"type":"string|number|boolean",' +
        '"description":"...","enum":["..."]}}}\'',
    )
    .option(
      "--trigger <kind>",
      "When to evaluate: root-span-finished | span-name. " +
        "Omitted → root-span-finished",
    )
    .option(
      "--span-name <name>",
      "Span name to trigger on (repeatable). Requires --trigger span-name",
      // No default: an absent flag must stay `undefined` so the handler can tell
      // "not passed" from "passed empty" and omit the key from the request.
      collectFlag,
    )
    .option(
      "--filter <expr>",
      "Filter as JSON (repeatable, ANDed): " +
        '\'{"column":"total_token_count","operator":"gt","value":"1000"}\'. ' +
        "Omitted → the default >1000 tokens",
      collectFlag,
    )
    .option("--mode <mode>", "batch | realtime. Omitted → realtime")
    .option(
      "--sample-rate <percent>",
      "Evaluate only this percent of matching traces (1-95). Omitted → no sampling",
    )
    .option("--disabled", "Create the signal deactivated")
    .option(
      "--llm-profile-id <id>",
      "Workspace LLM profile id to run the signal on (self-hosted only). " +
        "Required together with --model on self-hosted; rejected on Laminar Cloud. " +
        "Discover ids with `lmnr-cli llm-profile list`",
    )
    .option(
      "--model <name>",
      "Model to use from the profile (self-hosted only). " +
        "Required together with --llm-profile-id",
    )
    .action(withProjectClient(handleSignalCreate))
    .addHelpText(
      "after",
      `
Creates a Signal exactly as the UI's "Create signal" flow does, including the
auto-created critical-severity alert subscribed to your email.

Payload schema rules (identical to the UI):
  - field names must be identifiers: ^[a-zA-Z_][a-zA-Z0-9_]*$
  - field types: "string", "number", "boolean" (enum: "string" + "enum": [...])
  - every field is required
${TRIGGER_HELP}
LLM profile (self-hosted only):
  --llm-profile-id <id> and --model <name> together pick a workspace LLM
  profile and one of its models to run the signal on. Both are REQUIRED on
  self-hosted deployments and REJECTED on Laminar Cloud. Discover profile ids
  with \`lmnr-cli llm-profile list\`.

Examples:
  $ lmnr-cli signal create "Refund requests" \\
      --prompt "Detect when the user asks for a refund. Extract the reason." \\
      --schema '{"properties":{"reason":{"type":"string","description":"Refund reason"}}}'

  $ lmnr-cli signal create "Agent failures" \\
      --prompt "Find failures. Rate severity." \\
      --schema '{"properties":{"sev":{"type":"string","enum":["low","high"],\
"description":"Severity"}}}' \\
      --trigger span-name --span-name agent.run \\
      --filter '{"column":"status","operator":"eq","value":"error"}' \\
      --mode realtime --sample-rate 25 --json

  $ lmnr-cli signal create "Refund requests" \\
      --prompt "Detect refund asks." \\
      --schema '{"properties":{"reason":{"type":"string","description":"Refund reason"}}}' \\
      --llm-profile-id 3f6c9f1e-8f4b-4b0e-9d3a-2f4f4a6d8b11 --model gpt-4o
`,
    );

  signalCmd
    .command("update")
    .description("Update a signal (only the flags you pass are changed)")
    .argument("<signal>", "Signal id or name")
    .option("--prompt <prompt>", "Replace the LLM instruction")
    .option(
      "--schema <json>",
      "Replace the payload schema (same shape as create)",
    )
    .option(
      "--trigger <kind>",
      "Change when it is evaluated: root-span-finished | span-name",
    )
    .option(
      "--span-name <name>",
      "Span name to trigger on (repeatable). Requires --trigger span-name",
      // No default: an absent flag must stay `undefined` so the handler can tell
      // "not passed" from "passed empty" and omit the key from the request.
      collectFlag,
    )
    .option(
      "--filter <expr>",
      "Replace ALL filters with these (repeatable, same syntax as create)",
      collectFlag,
    )
    .option(
      "--no-filters",
      "Clear all filters (run on every trace it fires for)",
    )
    .option("--mode <mode>", "batch | realtime")
    .option("--sample-rate <percent>", "Set the sampling percent (1-95)")
    .option("--no-sampling", "Clear sampling (evaluate every matching trace)")
    .option("--disabled", "Deactivate the signal")
    .option("--no-disabled", "Reactivate the signal")
    .option(
      "--llm-profile-id <id>",
      "Re-route the signal onto a workspace LLM profile by id (self-hosted " +
        "only). Must be paired with --model. There is no flag to clear the " +
        "route back to the server's env LLM.",
    )
    .option(
      "--model <name>",
      "Model to use from the profile. Must be paired with --llm-profile-id",
    )
    .action(withProjectClient(handleSignalUpdate))
    .addHelpText(
      "after",
      `
This is a PARTIAL update: any flag you omit keeps its stored value, so changing
the prompt will not clear sampling, reactivate a disabled signal, or alter when
it fires. --trigger, --filter, and --mode are independent — changing one leaves
the other two alone. --filter REPLACES the whole filter set. --llm-profile-id
and --model must be passed together to re-route the signal (self-hosted only).
${TRIGGER_HELP}
Examples:
  $ lmnr-cli signal update "Refund requests" --prompt "Detect refund asks only"
  $ lmnr-cli signal update "Refund requests" --sample-rate 10
  $ lmnr-cli signal update "Refund requests" --no-sampling
  $ lmnr-cli signal update "Refund requests" --disabled
  $ lmnr-cli signal update "Refund requests" --no-disabled
  $ lmnr-cli signal update "Refund requests" \\
      --filter '{"column":"total_token_count","operator":"gt","value":"5000"}'
  $ lmnr-cli signal update "Refund requests" --no-filters
  $ lmnr-cli signal update "Refund requests" \\
      --llm-profile-id 3f6c9f1e-8f4b-4b0e-9d3a-2f4f4a6d8b11 --model gpt-4o-mini
  $ lmnr-cli signal update "Refund requests" --mode realtime
  $ lmnr-cli signal update "Refund requests" \\
      --trigger span-name --span-name agent.run --span-name worker.step
`,
    );

  signalCmd
    .command("delete")
    .description("Delete a signal, its triggers, its alerts, and its events")
    .argument("<signal>", "Signal id or name")
    .action(withProjectClient(handleSignalDelete))
    .addHelpText(
      "after",
      `
Deletion is permanent and also removes the signal's alerts and every signal
event it produced (in ClickHouse). A name must match exactly one signal.

Examples:
  $ lmnr-cli signal delete "Refund requests"
  $ lmnr-cli signal delete 29b937f1-7e3c-4768-a5e3-7e891c2d7d0a --json
`,
    );

  const llmProfileCmd = program
    .command("llm-profile")
    .alias("llm-profiles")
    .description(
      "Manage the workspace LLM profiles signals can run on (self-hosted only)",
    )
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

  /**
   * Provider-shape flags shared by `create` and `update`. Which combination a
   * provider needs is validated server-side; the flags only assemble the body.
   * The provider endpoint flag is `--provider-base-url` because `--base-url`
   * (group level) is the Laminar API URL and `optsWithGlobals` would shadow it.
   */
  const addProfileShapeOptions = (cmd: Command): Command =>
    cmd
      .option(
        "--model <name>",
        "Model the profile declares (repeatable). On update, REPLACES the " +
          "whole model list",
        collectFlag,
      )
      .option("--api-key <key>", "API key (all providers except Bedrock)")
      .option(
        "--access-key-id <id>",
        "AWS access key id (Bedrock; selects AWS-keys auth, " +
          "pair with --secret-access-key)",
      )
      .option("--secret-access-key <key>", "AWS secret access key (Bedrock)")
      .option(
        "--token <token>",
        "Bearer token (Bedrock; selects bearer-token auth)",
      )
      .option("--region <region>", "AWS region (Bedrock)")
      .option(
        "--resource-id <id>",
        "Azure resource id (alternative to --provider-base-url)",
      )
      .option(
        "--provider-base-url <url>",
        "Provider endpoint URL (Azure alternative to --resource-id; " +
          "required for custom). NOT the Laminar API URL — that is --base-url",
      )
      .option("--api-version <version>", "Azure API version")
      .option(
        "--header <name=value>",
        "Custom header for the custom provider (repeatable). Names are " +
          "stored in the profile config, values as secrets",
        collectFlag,
      );

  llmProfileCmd
    .command("list")
    .description(
      "List the workspace LLM profiles with the models each declares",
    )
    .action(withProjectClient(handleLlmProfileList))
    .addHelpText(
      "after",
      `
LLM profiles are workspace-scoped provider + credentials + models pairings a
signal can be pinned to. Self-hosted only: on Laminar Cloud the server rejects
the request with "LLM profiles are not available on this deployment".

Feed the printed \`ID\` and one of its \`Models\` to
\`lmnr-cli signal create --llm-profile-id <id> --model <name>\`
or \`lmnr-cli signal update ... --llm-profile-id <id> --model <name>\`.

Examples:
  $ lmnr-cli llm-profile list
  $ lmnr-cli llm-profile list --json
`,
    );

  llmProfileCmd
    .command("get")
    .description("Show one LLM profile (secrets appear as masks)")
    .argument("<profile-id>", "Profile id (see `lmnr-cli llm-profile list`)")
    .action(withProjectClient(handleLlmProfileGet))
    .addHelpText(
      "after",
      `
Secrets are write-only: the server returns a first3***last3 mask per stored
value plus custom header names, never the plaintext.

Examples:
  $ lmnr-cli llm-profile get 3f6c9f1e-8f4b-4b0e-9d3a-2f4f4a6d8b11
  $ lmnr-cli llm-profile get 3f6c9f1e-8f4b-4b0e-9d3a-2f4f4a6d8b11 --json
`,
    );

  addProfileShapeOptions(
    llmProfileCmd
      .command("create")
      .description("Create a workspace LLM profile")
      .argument("<name>", "Profile name (unique per workspace)")
      .requiredOption(
        "--provider <provider>",
        "openai_completions | openai_responses | gemini | bedrock | " +
          "azure_chat_completions | azure_responses | azure_anthropic | custom",
      ),
  )
    .action(withProjectClient(handleLlmProfileCreate))
    .addHelpText(
      "after",
      `
Per-provider flags (everything else is rejected server-side):
  openai_*, gemini:        --api-key
  azure_*:                 --api-key + exactly one of --resource-id /
                           --provider-base-url; optional --api-version
  bedrock:                 --region + either --access-key-id with
                           --secret-access-key, or --token
  custom (OpenAI-compat):  --api-key + --provider-base-url;
                           optional --header <name=value> (repeatable)

Examples:
  $ lmnr-cli llm-profile create prod-openai --provider openai_responses \\
      --api-key sk-... --model gpt-4o --model gpt-4o-mini

  $ lmnr-cli llm-profile create bedrock-eu --provider bedrock \\
      --region eu-west-1 --access-key-id AKIA... --secret-access-key ... \\
      --model anthropic.claude-3-5-sonnet-20240620-v1:0

  $ lmnr-cli llm-profile create gateway --provider custom \\
      --provider-base-url https://gw.internal.example.com --api-key key \\
      --header X-Team=ml --model gpt-4o
`,
    );

  addProfileShapeOptions(
    llmProfileCmd
      .command("update")
      .description("Update an LLM profile (only the flags you pass change)")
      .argument("<profile-id>", "Profile id (see `lmnr-cli llm-profile list`)")
      .option("--name <name>", "Rename the profile")
      .option(
        "--provider <provider>",
        "Change the provider (requires re-passing the config flags)",
      ),
  )
    .action(withProjectClient(handleLlmProfileUpdate))
    .addHelpText(
      "after",
      `
Partial update with two caveats:
  - Any config flag (--region, --resource-id, --provider-base-url,
    --api-version, --header, --access-key-id, --token) sends a WHOLE new
    config, so re-pass every config field the provider needs.
  - --model REPLACES the whole model list. Removing a model that a signal is
    pinned to is refused.
Omitted secrets keep their stored values, so credentials never need re-sending.

Examples:
  $ lmnr-cli llm-profile update 3f6c9f1e-... --name staging-openai
  $ lmnr-cli llm-profile update 3f6c9f1e-... --api-key sk-new
  $ lmnr-cli llm-profile update 3f6c9f1e-... --model gpt-4o --model o3-mini
`,
    );

  llmProfileCmd
    .command("delete")
    .description("Delete an LLM profile (refused while a signal uses it)")
    .argument("<profile-id>", "Profile id (see `lmnr-cli llm-profile list`)")
    .action(withProjectClient(handleLlmProfileDelete))
    .addHelpText(
      "after",
      `
Deletion is permanent. The server refuses while any signal still routes
through the profile — re-route or delete those signals first.

Examples:
  $ lmnr-cli llm-profile delete 3f6c9f1e-8f4b-4b0e-9d3a-2f4f4a6d8b11
`,
    );

  const askCmd = program
    .command("ask")
    .description(
      "Ask the Laminar agent a natural-language question about your project",
    )
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
    .option(
      "--json",
      "Output structured JSON ({ answer, conversationId, tools }) to stdout",
    );
  withTrackingOptions(askCmd)
    .action(withLocalOpts(handleAsk))
    .addHelpText(
      "after",
      `
Runs on your logged-in user session (\`lmnr-cli login\`) and targets a project via
--project-id or the linked .lmnr/project.json. The agent answers from your
project's traces/spans/evals via read-only SQL and trace inspection.

When a debug session is active in this directory, the command (and its args) is
recorded into that session as a \`command\` block. The raw question is uploaded.
Attach agent reasoning with --reasoning. Disable recording with --no-track or
LMNR_NO_COMMAND_TRACKING=1.

Examples:
  $ lmnr-cli ask "why did my latest trace fail?"
  $ lmnr-cli ask "how many traces errored in the last day?"
  $ lmnr-cli ask "summarize the most expensive trace today" --json
  $ lmnr-cli ask "and which model did it use?" --conversation <id>
  $ lmnr-cli ask "why did my latest trace fail?" --reasoning "triaging the failure"
  $ lmnr-cli ask "why did my latest trace fail?" --no-track
`,
    );

  const projectCmd = program
    .command("project")
    .description("Work with Laminar projects");

  projectCmd
    .command("list")
    .description(
      "List the projects you can access (● = linked to this directory)",
    )
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
    .description(
      "Re-point this directory to a project (rewrites .lmnr/project.json)",
    )
    .option(
      "--project-id <id>",
      "Project to link. Omit to open the interactive (alphabetically sorted) picker",
    )
    .option(
      "--base-url <url>",
      "Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable",
    )
    .option("--no-write-env", "Do not write LMNR_PROJECT_API_KEY to ./.env")
    .option(
      "--json",
      "Emit a machine-readable JSON line ({ projectId, ... }) on stdout",
    )
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
    .description(
      "Mint a fresh Project API Key for the linked project and print it",
    )
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
      process.stderr.write(
        `${pc.green("✓")} Logged in as ${result.userEmail ?? "<unknown>"}.\n`,
      );
      process.stderr.write(
        pc.dim(
          "Client: lmnr-cli. Tokens stored at ~/.config/lmnr/credentials.json (mode 0600).\n",
        ),
      );
      process.stderr.write(
        pc.dim(
          "Run `lmnr-cli setup` in a project directory to link it and write its API key.\n",
        ),
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
    .description(
      "Show the signed-in user, linked project, and active debug session",
    )
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
    .option(
      "--write-env",
      "Write LMNR_PROJECT_API_KEY to ./.env (default)",
      true,
    )
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
    .description(
      "Install the Laminar agent skill into this directory's agent dirs",
    )
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
    .description(
      "Replace every installed Laminar agent skill with the latest version",
    )
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
    .description("Set up the Laminar plugin or extension for a coding agent");

  pluginCmd
    .command("add")
    .description(
      "Log in, pick a project, mint a key, and install the Laminar plugin for a coding agent",
    )
    .argument(
      "<agent>",
      `Which agent to set up (currently: ${Object.keys(AGENTS).join(", ")})`,
    )
    .option(
      "--project-id <id>",
      "Project to send this agent's traces to (skips the interactive picker)",
    )
    .option(
      "--print-only",
      "Print the install commands instead of running them",
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
    .action(async (agent: string, options) => {
      await handlePluginAdd(agent, options);
    })
    .addHelpText(
      "after",
      `
Global, directory-independent setup: it does NOT touch .lmnr/project.json or
.env. The minted key is named after the plugin (find/revoke it in the dashboard)
and written to a file under ~/.config/lmnr/, where the plugin reads it. Claude
Code and Codex install from their native plugin marketplace; Pi installs the
npm package @lmnr-ai/pi-extension. Restart the agent after install to activate it.

When the host CLI isn't found (or is too old to install), or with --print-only,
the install commands are printed for you to run by hand.

Examples:
  $ lmnr-cli plugin add claude-code
  $ lmnr-cli plugin add codex
  $ lmnr-cli plugin add pi
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
    .description(
      "Attach a free-text note to a debug session (a standalone text block)",
    )
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
    .description(
      "Print every block in a debug session (traces, evals, notes), oldest first",
    )
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
    .description(
      "Create a fresh debug session and reset .lmnr/debug-session.json",
    )
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
  lmnr-cli plugin add pi                                   # Install the Pi extension

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
