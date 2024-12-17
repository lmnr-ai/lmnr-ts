#!/usr/bin/env node

import { ArgumentParser } from "argparse";
import * as esbuild from "esbuild";
import * as glob from "glob";

const pjson = require('../package.json');

export function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}) {
  // TODO: Figure out how to remove all ts-ignores
  // TODO: Cleanup by setting the original values of _evaluation and _set_global_evaluation back
  // @ts-ignore
  globalThis._evaluation = undefined;  // @ts-ignore
  globalThis._set_global_evaluation = true;  // @ts-ignore

  // it needs "require" to be passed in
  new Function("require", moduleText)(require);

  // Return the modified _evals global variable
  // @ts-ignore
  return globalThis._evaluation;
}

async function cli() {
  const [, , ...args] = process.argv;

  // Use argparse, which is the port of the python library
  const parser = new ArgumentParser({
    prog: "lmnr",
    description: "CLI for Laminar. Use `lmnr <subcommand> --help` for more information.",
  });

  parser.add_argument("-v", "--version", { action: "version", version: pjson.version });

  const subparsers = parser.add_subparsers({
    title: "subcommands",
    dest: "subcommand",
  });

  const parserEval = subparsers.add_parser("eval", {
    description: "Run an evaluation",
    help: "Run an evaluation",
  });

  parserEval.add_argument("file", {
    help: "A file containing the evaluation to run. If no file is provided, " +
      "the evaluation will run all `*.eval.ts|js` files in the `evals` directory.",
    nargs: "?",
  });

  parserEval.add_argument("--fail-on-error", {
    help: "Fail on error. If specified, will fail if encounters a file that cannot be run",
    action: "store_true",
  });

  parserEval.set_defaults({
    func: async (args: any) => {
      const files = args.file
        ? [args.file]
        : glob.sync('evals/**/*.eval.{ts,js}')

      files.sort();

      if (files.length === 0) {
        console.error("No evaluation files found. Please provide a file or " +
          "ensure there are files in the `evals` directory.");
        process.exit(1);
      }

      if (!args.file) {
        console.log(`Located ${files.length} evaluation files in evals/`);
      }

      for (const file of files) {
        console.log(`Loading ${file}...`);
        // TODO: Add various optimizations, e.g. minify, pure, tree shaking, etc.
        const buildOptions = {
          entryPoints: [file],
          outfile: `tmp_out_${file}.js`,
          write: false,  // will be loaded in memory as a temp file
          platform: "node" as esbuild.Platform,
          bundle: true,
          external: ["node_modules/*"],
        };

        const result = await esbuild.build(buildOptions);

        if (!result.outputFiles) {
          console.error("Error when building: No output files found");
          if (args.fail_on_error) {
            process.exit(1);
          }
          continue;
        }

        const outputFileText = result.outputFiles[0].text;

        const evaluation = loadModule({
          filename: args.file,
          moduleText: outputFileText,
        });

        // @ts-ignore
        if (!evaluation?.run) {
          console.error(`Evaluation ${file} does not properly call evaluate()`);
          if (args.fail_on_error) {
            process.exit(1);
          }
          continue;
        }

        // @ts-ignore
        await evaluation.run();
      }
    }
  });

  parser.set_defaults({
    func: async (args: any) => {
      parser.print_help();
      process.exit(0);
    }
  });

  const parsed = parser.parse_args(args);
  await parsed.func(parsed);
}

cli();
