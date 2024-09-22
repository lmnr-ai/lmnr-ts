#!/usr/bin/env node

import { ArgumentParser } from "argparse";
import * as esbuild from "esbuild";

const pjson = require('../package.json');

export function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}) {
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
        description: "CLI for Laminar",
    });

    parser.add_argument("-v", "--version", { action: "version", version: pjson.version });

    const subparsers = parser.add_subparsers({
        title: "subcommands",
        dest: "subcommand",
    });

    const parser_eval = subparsers.add_parser("eval", {
        description: "Run an evaluation",
    });

    parser_eval.add_argument("file", {
        help: "A file containing the evaluation to run",
    });

    parser_eval.set_defaults({
        func: async (args: any) => {
            // TODO: Add various optimizations, e.g. minify, pure, tree shaking, etc.
            const buildOptions = {
              entryPoints: [args.file],
              outfile: "tmp_out.js",
              write: false,  // will be loaded in memory as a temp file
              platform: "node" as esbuild.Platform,
              bundle: true,
              external: ["*"],
            };

            const result = await esbuild.build(buildOptions);

            if (!result.outputFiles) {
                console.error("Error when building: No output files found");
                process.exit(1);
            }

            const outputFileText = result.outputFiles[0].text;

            const evaluation = loadModule({
              filename: args.file,
              moduleText: outputFileText,
            });

            // @ts-ignore
            await evaluation.run();
        }
    });

    const parsed = parser.parse_args(args);
    await parsed.func(parsed);
}

cli();
