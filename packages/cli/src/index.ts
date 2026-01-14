#!/usr/bin/env node

import { Command } from 'commander';

import { version } from '../package.json';
import { runDev } from './commands/dev';

async function main() {
  const program = new Command();

  program
    .name('@lmnr-ai/cli')
    .description('CLI for Laminar AI rollout debugging')
    .version(version, '-v, --version', 'display version number');

  program
    .command('dev')
    .description('Start a rollout debugging session')
    .argument(
      '[file]',
      'Path to file containing the agent function(s). Either `file` or `-m` must be provided.',
    )
    .option(
      '-m, --python-module <module>',
      'Python module path (e.g., src.myfile). Either `file` or `-m` must be provided.',
    )
    .option(
      '--function <name>',
      'Specific function to serve (if multiple rollout functions found)',
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
      'This is meant to skip the imports that are not used in the rollout itself.',
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
  $ @lmnr-ai/cli dev agent.ts                    # TypeScript file
  $ @lmnr-ai/cli dev agent.py                    # Python file (script mode)
  $ @lmnr-ai/cli dev -m src.agent                # Python module (module mode)
  $ @lmnr-ai/cli dev agent.ts --function myAgent # Specific function
`,
    );

  await program.parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
