#!/usr/bin/env node

import { ArgumentParser } from "argparse";
import * as esbuild from "esbuild";
import * as glob from "glob";

import { version } from "../package.json";
import { Evaluation } from "./evaluations";
import { getDirname, initializeLogger } from "./utils";

const logger = initializeLogger();

declare global {
  // eslint-disable-next-line no-var
  var _evaluations: Evaluation<any, any, any>[] | undefined;
  // eslint-disable-next-line no-var
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
  return globalThis._evaluations!;
}

async function cli() {
  const [, , ...args] = process.argv;

  // Use argparse, which is the port of the python library
  const parser = new ArgumentParser({
    prog: "lmnr",
    description: "CLI for Laminar. Use `lmnr <subcommand> --help` for more information.",
  });

  parser.add_argument("-v", "--version", { action: "version", version });

  const subparsers = parser.add_subparsers({
    title: "subcommands",
    dest: "subcommand",
  });

  const parserEval = subparsers.add_parser("eval", {
    description: "Run an evaluation",
    help: "Run an evaluation",
  });

  parserEval.add_argument("files", {
    help: "A file or files containing the evaluation to run. If no file is provided, " +
      "the evaluation will run all `*.eval.ts|js` files in the `evals` directory. " +
      "If multiple files are provided, the evaluation will run each file in order.",
    nargs: "*",
  });

  parserEval.add_argument("--fail-on-error", {
    help: "Fail on error. If specified, will fail if encounters a file that cannot be run",
    action: "store_true",
  });

  parserEval.set_defaults({
    func: async (args: any) => {
      let files: string[];
      if (args.files && args.files.length > 0) {
        files = args.files.flatMap((file: string) => glob.globSync(file));
      } else {
        // No files provided, use default pattern
        files = glob.sync('evals/**/*.eval.{ts,js}');
      }

      files.sort();

      if (files.length === 0) {
        logger.error("No evaluation files found. Please provide a file or " +
          "ensure there are eval files that are named like `*.eval.{ts,js}` in" +
          "the `evals` directory or its subdirectories.");
        process.exit(1);
      }

      if (!args.files) {
        logger.info(`Located ${files.length} evaluation files in evals/`);
      } else {
        logger.info(`Running ${files.length} evaluation files.`);
      }

      for (const file of files) {
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
          ],
          treeShaking: true,
        };

        const result = await esbuild.build(buildOptions);

        if (!result.outputFiles) {
          logger.error("Error when building: No output files found " +
            "it is likely that all eval files are not valid TypeScript or JavaScript files.");
          if (args.fail_on_error) {
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
            if (args.fail_on_error) {
              process.exit(1);
            }
            continue;
          }

          await evaluation.run();
        }
      }
    },
  });

  parser.set_defaults({
    func: () => {
      parser.print_help();
      process.exit(0);
    },
  });

  const parsed = parser.parse_args(args);
  await parsed.func(parsed);
}

cli().catch((err) => {
  logger.error(err instanceof Error ? err.message : err);
  throw err;
});
