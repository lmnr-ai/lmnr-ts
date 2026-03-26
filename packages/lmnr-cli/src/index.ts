#!/usr/bin/env node

import { Command } from 'commander';

import { version } from '../package.json';
import {
  handleDatasetsCreate,
  handleDatasetsList,
  handleDatasetsPull,
  handleDatasetsPush,
} from './commands/datasets';
import { runDev } from './commands/dev';

async function main() {
  const program = new Command();

  program
    .name('lmnr-cli')
    .description('CLI for the Laminar agent observability platform')
    .version(version, '-v, --version', 'display version number');


  program
    .command('dev')
    .description('Start a debugging session')
    .argument(
      '[file]',
      'Path to file containing the entrypoint function(s). Either `file` or `-m` must be provided.',
    )
    .option(
      '-m, --python-module <module>',
      'Python module path (e.g., src.myfile). Either `file` or `-m` must be provided.',
    )
    .option(
      '--function <name>',
      'Specific function to serve (if multiple entrypoint functions found)',
    )
    .option(
      '--project-api-key <key>',
      'Project API key. If not provided, reads from LMNR_PROJECT_API_KEY env variable',
    )
    .option(
      '--base-url <url>',
      'Base URL for the Laminar API. Defaults to https://api.lmnr.ai or LMNR_BASE_URL env variable',
    )
    .option('--port <port>', 'Port for the Laminar API. Defaults to 443', (val) =>
      parseInt(val, 10),
    )
    .option(
      '--grpc-port <port>',
      'Port for the Laminar gRPC backend. Defaults to 8443',
      (val) => parseInt(val, 10),
    )
    .option(
      '--frontend-port <port>',
      'Port for the Laminar frontend. Defaults to 5667',
      (val) => parseInt(val, 10),
    )
    .option(
      '--external-packages <packages...>',
      '[ADVANCED] List of packages to pass as external to esbuild. This will not link ' +
      'the packages directly into the dev file, but will instead require them at runtime. ' +
      'Read more: https://esbuild.github.io/api/#external',
    )
    .option(
      '--dynamic-imports-to-skip <modules...>',
      '[ADVANCED] List of module names to skip when encountered as dynamic imports. ' +
      'These dynamic imports will resolve to an empty module to prevent build failures. ' +
      'This is meant to skip the imports that are not used in the entrypoint function itself.',
    )
    .option(
      '--command <command>',
      '[ADVANCED] Custom command to run the worker (e.g., python3, node)',
    )
    .option(
      '--command-args <args...>',
      '[ADVANCED] Arguments for the custom command',
    )
    .action(async (file: string | undefined, options) => {
      // Validation: must have either file or python-module, but not both
      if (!file && !options.pythonModule) {
        console.error('Error: Must provide either a file path or --python-module (-m) flag');
        process.exit(1);
      }
      if (file && options.pythonModule) {
        console.error('Error: Cannot specify both file path and --python-module (-m) flag');
        process.exit(1);
      }

      await runDev(file, options);
    })
    .addHelpText(
      'after',
      `
Examples:
  $ lmnr-cli dev agent.ts                    # TypeScript file
  $ lmnr-cli dev agent.py                    # Python file (script mode)
  $ lmnr-cli dev -m src.agent                # Python module (module mode)
  $ lmnr-cli dev agent.ts --function myAgent # Specific function
`,
    );

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
    .action(async (paths: string[], _options, cmd) => {
      await handleDatasetsPush(paths, cmd.optsWithGlobals());
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
    .action(async (outputPath: string | undefined, _options, cmd) => {
      await handleDatasetsPull(outputPath, cmd.optsWithGlobals());
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
    .action(async (name: string, paths: string[], _options, cmd) => {
      await handleDatasetsCreate(name, paths, cmd.optsWithGlobals());
    });


  await program.parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
