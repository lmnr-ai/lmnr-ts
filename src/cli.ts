#!/usr/bin/env node

import { Command } from "commander";
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as glob from "glob";

import { version } from "../package.json";
import { Evaluation } from "./evaluations";
import { getDirname, initializeLogger } from "./utils";

const logger = initializeLogger();

// esbuild plugin to skip dynamic imports
const createSkipDynamicImportsPlugin = (skipModules: string[]): esbuild.Plugin => ({
  name: 'skip-dynamic-imports',
  setup(build) {
    if (!skipModules || skipModules.length === 0) return;

    build.onResolve({ filter: /.*/ }, (args) => {
      // Only handle dynamic imports
      if (args.kind === 'dynamic-import' && skipModules.includes(args.path)) {
        logger.warn(`Skipping dynamic import: ${args.path}`);
        // Return a virtual module that exports an empty object
        return {
          path: args.path,
          namespace: 'lmnr-skip-dynamic-import',
        };
      }
    });

    // Provide empty module content for skipped dynamic imports
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    build.onLoad({ filter: /.*/, namespace: 'lmnr-skip-dynamic-import' }, (args) => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
});

declare global {
  var _evaluations: Evaluation<any, any, any>[] | undefined;
  var _set_global_evaluation: boolean;
}

export function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}): Evaluation<any, any, any>[] {
  globalThis._evaluations = [];
  globalThis._set_global_evaluation = true;

  const __filename = filename;
  const __dirname = getDirname();

  // add some arguments for proper cjs/esm interop

  /* eslint-disable @typescript-eslint/no-implied-eval */
  new Function(
    "require",
    "module",
    "__filename",
    "__dirname",
    moduleText,
  )(
    require,
    module,
    __filename,
    __dirname,
  );
  /* eslint-enable @typescript-eslint/no-implied-eval */

  // Return the modified _evals global variable
  return globalThis._evaluations;
}

async function cli() {
  const program = new Command();

  program
    .name("lmnr")
    .description("CLI for Laminar. Use `lmnr <subcommand> --help` for more information.")
    .version(version, "-v, --version", "display version number");

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
    .action(async (files: string[], options: {
      failOnError?: boolean;
      outputFile?: string;
      externalPackages?: string[];
      dynamicImportsToSkip?: string[];
    }) => {
      let evalFiles: string[];
      if (files && files.length > 0) {
        evalFiles = files.flatMap((file: string) => glob.sync(file));
      } else {
        // No files provided, use default pattern
        evalFiles = glob.sync('evals/**/*.eval.{ts,js}');
      }

      evalFiles.sort();

      if (evalFiles.length === 0) {
        logger.error("No evaluation files found. Please provide a file or " +
          "ensure there are eval files that are named like `*.eval.{ts,js}` in " +
          "the `evals` directory or its subdirectories.");
        process.exit(1);
      }

      if (files.length === 0) {
        logger.info(`Located ${evalFiles.length} evaluation files in evals/`);
      } else {
        logger.info(`Running ${evalFiles.length} evaluation files.`);
      }

      const scores: {
        file: string,
        scores: Record<string, number>,
        url: string,
        evaluationId: string,
      }[] = [];

      for (const file of evalFiles) {
        logger.info(`Loading ${file}...`);
        const buildOptions = {
          bundle: true,
          platform: "node" as esbuild.Platform,
          entryPoints: [file],
          outfile: `tmp_out_${file}.js`,
          write: false,  // will be loaded in memory as a temp file
          external: [
            "node_modules/*",
            "playwright",
            "puppeteer",
            "puppeteer-core",
            "playwright-core",
            "fsevents",
            ...(options.externalPackages ? options.externalPackages : []),
          ],
          plugins: [
            createSkipDynamicImportsPlugin(options.dynamicImportsToSkip || []),
          ],
          treeShaking: true,
        };

        const result = await esbuild.build(buildOptions);

        if (!result.outputFiles) {
          logger.error("Error when building: No output files found " +
            "it is likely that all eval files are not valid TypeScript or JavaScript files.");
          if (options.failOnError) {
            process.exit(1);
          }
          continue;
        }

        const outputFileText = result.outputFiles[0].text;

        const evaluations = loadModule({
          filename: file,
          moduleText: outputFileText,
        });

        logger.info(`Loaded ${evaluations.length} evaluations from ${file}`);

        for (const evaluation of evaluations) {
          if (!evaluation?.run) {
            logger.error(`Evaluation ${file} does not properly call evaluate()`);
            if (options.failOnError) {
              process.exit(1);
            }
            continue;
          }

          const evalResult = await evaluation.run();
          scores.push({
            file,
            scores: evalResult?.averageScores ?? {},
            url: evalResult?.url ?? '',
            evaluationId: evalResult?.evaluationId ?? '',
          });
        }
      }

      if (options.outputFile) {
        fs.writeFileSync(options.outputFile, JSON.stringify(scores, null, 2));
      }
    });

  // If no command provided, show help
  if (!process.argv.slice(2).length) {
    program.help(); // This exits the process
    return;
  }

  await program.parseAsync();
}


cli().catch((err) => {
  logger.error(err instanceof Error ? err.message : err);
  throw err;
});
