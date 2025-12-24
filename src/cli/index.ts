#!/usr/bin/env node

import { Command } from "commander";

import { version } from "../../package.json";
import { Evaluation } from "../evaluations";
import { initializeLogger } from "../utils";
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from "./datasets";
import { runEvaluation } from "./evals";
import { runServe } from "./rollout/serve";

const logger = initializeLogger();

declare global {
  var _evaluations: Evaluation<any, any, any>[] | undefined;
  var _set_global_evaluation: boolean;
}

async function cli() {
  const program = new Command();

  program
    .name("lmnr")
    .description("CLI for Laminar. Use `lmnr <subcommand> --help` for more information.")
    .version(version, "-v, --version", "display version number");

  // Eval command
  program
    .command("eval")
    .description("Run an evaluation")
    .argument(
      "[files...]",
      "A file or files containing the evaluation to run. If no file is provided, " +
      "the evaluation will run all `*.eval.ts|js` files in the `evals` directory. " +
      "If multiple files are provided, the evaluation will run each file in order.",
    )
    .option(
      "--fail-on-error",
      "Fail on error. If specified, will fail if encounters a file that cannot be run",
    )
    .option(
      "--output-file <file>",
      "Output file to write the results to. Outputs are written in JSON format.",
    )
    .option(
      "--external-packages <packages...>",
      "[ADVANCED] List of packages to pass as external to esbuild. This will not link " +
      "the packages directly into the eval file, but will instead require them at runtime. " +
      "Read more: https://esbuild.github.io/api/#external",
    )
    .option(
      "--dynamic-imports-to-skip <modules...>",
      "[ADVANCED] List of module names to skip when encountered as dynamic imports. " +
      "These dynamic imports will resolve to an empty module to prevent build failures. " +
      "This is meant to skip the imports that are not used in the evaluation itself.",
    )
    .action(async (files: string[], options) => {
      await runEvaluation(files, options);
    });

  // Datasets command with global options
  const datasetsCmd = program
    .command("datasets")
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
    );

  // Datasets list command
  datasetsCmd
    .command("list")
    .description("List all datasets")
    .action(async (options, cmd) => {
      const parentOpts = cmd.parent?.opts() || {};
      await handleDatasetsList({ ...parentOpts, ...options });
    });

  // Datasets push command
  datasetsCmd
    .command("push")
    .description("Push datapoints to an existing dataset")
    .argument("<paths...>", "Paths to files or directories containing data to push")
    .option("-n, --name <name>", "Name of the dataset (either name or id must be provided)")
    .option("--id <id>", "ID of the dataset (either name or id must be provided)")
    .option("-r, --recursive", "Recursively read files in directories", false)
    .option(
      "--batch-size <size>",
      "Batch size for pushing data",
      (val) => parseInt(val, 10),
      100,
    )
    .action(async (paths: string[], options, cmd) => {
      const parentOpts = cmd.parent?.opts() || {};
      await handleDatasetsPush(paths, { ...parentOpts, ...options });
    });

  // Datasets pull command
  datasetsCmd
    .command("pull")
    .description("Pull data from a dataset")
    .argument("[output-path]", "Path to save the data. If not provided, prints to console")
    .option("-n, --name <name>", "Name of the dataset (either name or id must be provided)")
    .option("--id <id>", "ID of the dataset (either name or id must be provided)")
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
    .option("--limit <limit>", "Limit number of datapoints to pull", (val) => parseInt(val, 10))
    .option("--offset <offset>", "Offset for pagination", (val) => parseInt(val, 10), 0)
    .action(async (outputPath: string | undefined, options, cmd) => {
      const parentOpts = cmd.parent?.opts() || {};
      await handleDatasetsPull(outputPath, { ...parentOpts, ...options });
    });

  // Datasets create command
  datasetsCmd
    .command("create")
    .description("Create a dataset from input files")
    .argument("<name>", "Name of the dataset to create")
    .argument("<paths...>", "Paths to files or directories containing data to push")
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
    .action(async (name: string, paths: string[], options, cmd) => {
      const parentOpts = cmd.parent?.opts() || {};
      await handleDatasetsCreate(name, paths, { ...parentOpts, ...options });
    });

  // Serve command
  program
    .command("serve")
    .description("Start a rollout debugging session")
    .argument("<file>", "Path to file containing the agent function(s)")
    .option(
      "--function <name>",
      "Specific function to serve (if multiple rollout functions found)",
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
    .action(async (file: string, options) => {
      await runServe(file, options);
    });

  // If no command provided, show help
  if (!process.argv.slice(2).length) {
    program.help();
    return;
  }

  await program.parseAsync();
}

cli().catch((err) => {
  logger.error(err instanceof Error ? err.message : err);
  throw err;
});

