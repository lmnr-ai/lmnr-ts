#!/usr/bin/env node

import { context, propagation, trace } from "@opentelemetry/api";
import { ArgumentParser } from "argparse";
import * as esbuild from "esbuild";
import * as glob from "glob";

import { version } from "../package.json";
import { Evaluation } from "./evaluations";
import { initializeLogger } from "./utils";
import { getDirname } from "./utils";

const logger = initializeLogger();

declare global {
  // eslint-disable-next-line no-var
  var _evaluation: Evaluation<any, any, any, any> | undefined;
  // eslint-disable-next-line no-var
  var _set_global_evaluation: boolean;
}

export function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}): Evaluation<any, any, any, any> {
  globalThis._evaluation = undefined;
  globalThis._set_global_evaluation = true;

  const __filename = filename;
  const __dirname = getDirname();

  // add some arguments for proper cjs/esm interop
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

  // Return the modified _evals global variable
  return globalThis._evaluation!;
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
        : glob.sync('evals/**/*.eval.{ts,js}');

      files.sort();

      if (files.length === 0) {
        logger.error("No evaluation files found. Please provide a file or " +
          "ensure there are eval files that are named like `*.eval.{ts,js}` in" +
          "the `evals` directory or its subdirectories.");
        process.exit(1);
      }

      if (!args.file) {
        logger.info(`Located ${files.length} evaluation files in evals/`);
      }

      // Laminar should be marked external by passing 'node_modules/*' to the
      // external option. This plugin ensures that @lmnr-ai/lmnr is marked
      // external when imported from path or url.
      // Adapted from https://github.com/evanw/esbuild/issues/619#issuecomment-751769812
      const setLaminarAsExternalPlugin = {
        name: "set-laminar-as-external",
        setup(build: esbuild.PluginBuild) {
          build.onResolve({ filter: /^@lmnr-ai\/lmnr$/ }, (args) => {
            return {
              path: args.path,
              external: true,
            };
          });
        }
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
          plugins: [setLaminarAsExternalPlugin],
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

        const evaluation = loadModule({
          filename: args.file,
          moduleText: outputFileText,
        });

        if (!evaluation?.run) {
          logger.error(`Evaluation ${file} does not properly call evaluate()`);
          if (args.fail_on_error) {
            process.exit(1);
          }
          continue;
        }

        await evaluation.run();

        // FIXME: Now every evaluation file creates a new tracer provider.
        // Attempt to re-initialize it in the same process breaks it.
        // For now, we disable all APIs after running each file, but ideally
        // we should keep a global tracer provider that is initialized once
        // here in the CLI.
        context.disable();
        trace.disable();
        propagation.disable();
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
