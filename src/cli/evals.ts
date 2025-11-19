import * as esbuild from "esbuild";
import * as fs from "fs";
import { globSync } from "tinyglobby";

import { Evaluation } from "../evaluations";
import { getDirname, initializeLogger } from "../utils";

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

function loadModule({
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

export interface EvalCommandOptions {
  failOnError?: boolean;
  outputFile?: string;
  externalPackages?: string[];
  dynamicImportsToSkip?: string[];
}

export async function runEvaluation(
  files: string[],
  options: EvalCommandOptions,
): Promise<void> {
  let evalFiles: string[];
  if (files && files.length > 0) {
    evalFiles = files.flatMap((file: string) => globSync(file));
  } else {
    // No files provided, use default pattern
    evalFiles = globSync('evals/**/*.eval.{ts,js}');
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
        "esbuild",
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
}

