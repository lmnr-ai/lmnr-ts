import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

import { getDirname, initializeLogger } from '../../utils';

const logger = initializeLogger();

/**
 * esbuild plugin to load markdown files as raw strings
 */
export const rawMarkdownPlugin: esbuild.Plugin = {
  name: "raw-markdown",
  setup(build) {
    // Resolve .md imports
    build.onResolve({ filter: /\.md$/ }, (args) => ({
      path: path.isAbsolute(args.path)
        ? args.path
        : path.resolve(args.resolveDir, args.path),
      namespace: "raw-markdown",
    }));

    // Load .md files as raw strings
    build.onLoad({ filter: /.*/, namespace: "raw-markdown" }, async (args) => {
      const content = await fs.promises.readFile(args.path, "utf8");
      // Escape backticks and backslashes in the content
      const escaped = content
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$/g, "\\$");
      return {
        contents: `export default \`${escaped}\`;`,
        loader: "js",
      };
    });
  },
};

/**
 * esbuild plugin to skip dynamic imports
 */
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

export interface BuildOptions {
  externalPackages?: string[];
  dynamicImportsToSkip?: string[];
}

/**
 * Builds a file using esbuild
 */
export async function buildFile(
  filePath: string,
  options?: BuildOptions,
): Promise<string> {
  const result = await esbuild.build({
    bundle: true,
    platform: "node" as esbuild.Platform,
    entryPoints: [filePath],
    outfile: `tmp_out_${filePath}.js`,
    write: false,
    external: [
      "@lmnr-ai/*",
      "esbuild",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "playwright-core",
      "fsevents",
      ...(options?.externalPackages ?? []),
    ],
    plugins: [
      rawMarkdownPlugin,
      createSkipDynamicImportsPlugin(options?.dynamicImportsToSkip ?? []),
    ],
    treeShaking: true,
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("Failed to build file");
  }

  return result.outputFiles[0].text;
}

/**
 * Loads and executes a module to register rollout functions
 */
export function loadModule({
  filename,
  moduleText,
}: {
  filename: string;
  moduleText: string;
}): void {
  globalThis._rolloutFunctions = new Map();
  globalThis._set_rollout_global = true;

  const __filename = filename;
  const __dirname = getDirname();

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
}

/**
 * Selects the appropriate rollout function from the registered functions
 */
export function selectRolloutFunction(
  requestedFunctionName?: string,
): { fn: (...args: any[]) => any; params: any[]; name: string; exportName: string } {
  if (!globalThis._rolloutFunctions || globalThis._rolloutFunctions.size === 0) {
    throw new Error(
      "No rollout functions found in file. " +
      " Make sure you are using observe with rolloutEntrypoint: true",
    );
  }

  // If a specific function is requested, use that
  if (requestedFunctionName) {
    const selected = globalThis._rolloutFunctions.get(requestedFunctionName);
    if (!selected) {
      const available = Array.from(globalThis._rolloutFunctions.keys()).join(', ');
      throw new Error(
        `Function '${requestedFunctionName}' not found. Available functions: ${available}`,
      );
    }
    return { ...selected, exportName: requestedFunctionName };
  }

  // If only one function, auto-select it
  if (globalThis._rolloutFunctions.size === 1) {
    const [[exportName, selected]] = Array.from(globalThis._rolloutFunctions.entries());
    return { ...selected, exportName };
  }

  // Multiple functions found without explicit selection
  const available = Array.from(globalThis._rolloutFunctions.keys()).join(', ');
  throw new Error(
    `Multiple rollout functions found: ${available}. Use --function to specify which one to serve.`,
  );
}
