import type { RolloutParam } from '@lmnr-ai/types';
import * as path from 'path';

import { initializeLogger } from '../../utils';

const logger = initializeLogger();

export interface FunctionMetadata {
  name: string;          // The span name from observe({ name: '...' })
  exportName: string;    // The actual export/variable name
  params: RolloutParam[];
}

export interface DiscoveredMetadata {
  functionName: string;
  params: RolloutParam[];
}

// Extensions that use TypeScript/JavaScript build and runtime discovery
const TS_JS_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.mts',
  '.cts',
];

// All extensions that support metadata discovery
export const EXTENSIONS_TO_DISCOVER_METADATA = [...TS_JS_EXTENSIONS, '.py'];

/**
 * Protocol prefix for metadata discovery responses
 * This allows us to safely parse JSON even if there are other log statements in stdout
 */
export const METADATA_PROTOCOL_PREFIX = 'LMNR_METADATA:';

const logLmnrPackageNotFoundAndExit = () => {
  logger.error(
    '@lmnr-ai/lmnr package not found or outdated. ' +
    'For JS/TS projects, please install the latest version of @lmnr-ai/lmnr in your project: ' +
    'npm install @lmnr-ai/lmnr\n' +
    'You might need to run `lmnr-cli` from the root of your project',
  );
  process.exit(1);
};

/**
 * Discovers function metadata for TypeScript and JavaScript files by:
 * 1. Extracting TypeScript metadata (params with types from source - TS only)
 * 2. Building and loading the module with esbuild
 * 3. Selecting the appropriate function
 * 4. Matching metadata by span name
 *
 * For JavaScript files, TypeScript metadata extraction fails gracefully, but runtime
 * parameter extraction via regex still works (param names without types).
 */
const discoverTypeScriptMetadata = async (
  filePath: string,
  options: { function?: string; externalPackages?: string[]; dynamicImportsToSkip?: string[] },
): Promise<DiscoveredMetadata> => {
  let extractRolloutFunctions: any;
  let buildFile: any;
  let loadModule: any;
  let selectRolloutFunction: any;

  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // Use dynamic require to prevent bundler from trying to resolve at build time
    const lmnrPackage = '@lmnr-ai/lmnr';
    const tsParserPath = require.resolve(`${lmnrPackage}/dist/cli/worker/ts-parser.cjs`);
    const buildModulePath = require.resolve(`${lmnrPackage}/dist/cli/worker/build.cjs`);

    // Clear require cache to ensure we get fresh modules on reload
    delete require.cache[tsParserPath];
    delete require.cache[buildModulePath];

    extractRolloutFunctions = require(tsParserPath).extractRolloutFunctions;
    const buildModule = require(buildModulePath);
    buildFile = buildModule.buildFile;
    loadModule = buildModule.loadModule;
    selectRolloutFunction = buildModule.selectRolloutFunction;
    /* eslint-enable @typescript-eslint/no-require-imports */

    if (!extractRolloutFunctions || !buildFile || !loadModule || !selectRolloutFunction) {
      logger.error(
        "Missing exports from @lmnr-ai/lmnr modules. " +
        "This may indicate an outdated package version.",
      );
      logLmnrPackageNotFoundAndExit();
    }
  } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND') {
      logLmnrPackageNotFoundAndExit();
    }
    // Re-throw any other errors (syntax errors, etc.)
    logger.error(`Unexpected error loading @lmnr-ai/lmnr modules: ${error.message}`);
    throw error;
  }


  // Extract TypeScript metadata
  let paramsMetadata: Map<string, FunctionMetadata> | undefined;
  try {
    paramsMetadata = extractRolloutFunctions(filePath);
    logger.debug(`Extracted TypeScript metadata for ${paramsMetadata?.size} functions`);
  } catch (error) {
    logger.warn(
      'Failed to extract TypeScript metadata, falling back to runtime parsing: ' +
      (error instanceof Error ? error.message : String(error)),
    );
  }

  // Build and load the module
  const moduleText = await buildFile(filePath, {
    externalPackages: options.externalPackages,
    dynamicImportsToSkip: options.dynamicImportsToSkip,
  });
  loadModule({
    filename: filePath,
    moduleText,
  });

  // Select the appropriate function
  const selectedFunction = selectRolloutFunction(options.function);

  // If we have TypeScript metadata, match by span name and enrich params
  if (paramsMetadata) {
    logger.debug(`Available TS metadata keys: ${Array.from(paramsMetadata.keys()).join(', ')}`);
    logger.debug(
      `Looking for span name: ${selectedFunction.name} ` +
      `(runtime key: ${selectedFunction.exportName})`,
    );

    // Search for metadata by span name
    let foundMetadata: FunctionMetadata | null = null;
    for (const [exportName, metadata] of paramsMetadata.entries()) {
      logger.debug(
        `Checking ${exportName}: span name = ${metadata.name}, export name = ${exportName}`,
      );
      if (metadata.name === selectedFunction.name) {
        foundMetadata = metadata;
        logger.debug(`Match. Export name: ${exportName}, span name: ${metadata.name}`);
        break;
      }
    }

    if (foundMetadata) {
      selectedFunction.params = foundMetadata.params;
      logger.debug(`Using TypeScript metadata for span: ${selectedFunction.name}`);
    } else {
      logger.info(`No TypeScript metadata found for span name: ${selectedFunction.name}`);
    }
  }

  return {
    functionName: selectedFunction.name,
    params: selectedFunction.params || [],
  };
};

/**
 * Helper to execute subprocess commands
 */
const execCommand = async (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process');
  const child = spawn(command, args);
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('close', (code: number | null) => {
    if (code === 0) {
      resolve({ stdout, stderr });
    } else {
      reject(new Error(`Command failed with code ${code}: ${stderr}`));
    }
  });

  child.on('error', (error: Error) => {
    reject(error);
  });
});

/**
 * Extracts JSON metadata from stdout that may contain other log statements
 * Looks for lines matching the protocol prefix and parses the JSON payload
 *
 * @param stdout - Raw stdout output that may contain logs and metadata
 * @returns Parsed JSON object
 * @throws Error if no valid metadata line is found or JSON parsing fails
 */
export const extractMetadataFromStdout = (stdout: string): any => {
  // Find all positions where LMNR_METADATA: appears
  const prefixPositions: number[] = [];
  let searchStart = 0;
  while (true) {
    const pos = stdout.indexOf(METADATA_PROTOCOL_PREFIX, searchStart);
    if (pos === -1) break;
    prefixPositions.push(pos);
    searchStart = pos + METADATA_PROTOCOL_PREFIX.length;
  }

  if (prefixPositions.length === 0) {
    // Fallback: try parsing the entire stdout as JSON (backward compatibility)
    try {
      return JSON.parse(stdout.trim());
    } catch {
      throw new Error(
        "No metadata found in output. " +
        "Please make sure you are running the latest version of `lmnr` python package.",
      );
    }
  }

  // Try to parse JSON starting from each prefix position
  // We'll keep the last successfully parsed JSON
  let lastValidJson: any = null;

  for (const pos of prefixPositions) {
    // Start after the prefix
    const startPos = pos + METADATA_PROTOCOL_PREFIX.length;
    const jsonText = stdout.slice(startPos).trim();

    // Try to parse the JSON by attempting increasingly shorter substrings
    // Strategy: Look for the end of the JSON object/array by finding matching braces
    // This handles the case where there might be additional text after the JSON

    // First, try parsing to the next newline (most common case)
    const nextNewline = stdout.indexOf('\n', startPos);
    if (nextNewline !== -1) {
      const lineText = stdout.slice(startPos, nextNewline).trim();
      try {
        lastValidJson = JSON.parse(lineText);
        continue;
      } catch {
        // If that fails, we'll try the more complex approach below
      }
    }

    // More complex case: try to find the end of the JSON by counting braces
    // This handles multi-line JSON or JSON followed by more text
    try {
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let firstChar = -1;

      for (let i = 0; i < jsonText.length; i++) {
        const char = jsonText[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\' && inString) {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (char === '{' || char === '[') {
          if (firstChar === -1) firstChar = i;
          depth++;
        } else if (char === '}' || char === ']') {
          depth--;
          if (depth === 0 && firstChar !== -1) {
            // Found the end of the JSON object/array
            const candidate = jsonText.slice(0, i + 1);
            lastValidJson = JSON.parse(candidate);
            break;
          }
        }
      }

      // If we didn't find a complete object, try parsing the whole thing
      if (depth !== 0 || firstChar === -1) {
        lastValidJson = JSON.parse(jsonText);
      }
    } catch {
      // If parsing fails, continue to the next prefix position
      continue;
    }
  }

  if (lastValidJson === null) {
    throw new Error(
      "No valid metadata JSON found in output. " +
      "Please make sure you are running the latest version of `lmnr` python package.",
    );
  }

  return lastValidJson;
};

/**
 * Discovers function metadata for Python files/modules by calling the lmnr Python CLI
 */
const discoverPythonMetadata = async (
  filePathOrModule: string,
  options: { pythonModule?: string; function?: string },
): Promise<DiscoveredMetadata> => {
  logger.debug(`Discovering Python metadata for ${filePathOrModule}`);
  const args = ['discover'];

  // Determine if we're using a file path or module
  if (options.pythonModule) {
    // Module mode: lmnr discover --module src.myfile
    args.push('--module', options.pythonModule);
  } else {
    // Script mode: lmnr discover --file src/myfile.py
    args.push('--file', filePathOrModule);
  }

  // Add optional function name
  if (options.function) {
    args.push('--function', options.function);
  }

  try {
    // Execute: lmnr discover --file <path> | --module <module> [--function <name>]
    const result = await execCommand('lmnr', args);
    const response = extractMetadataFromStdout(result.stdout);

    // Response format: { "name": "...", "params": [...] }
    return {
      functionName: response.name,
      params: response.params || [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to discover Python metadata: ${errorMessage}`);
    if (errorMessage.toLowerCase().includes('command not found') ||
      errorMessage.includes('spawn lmnr ENOENT')) {
      logger.info(
        "HINT: Make sure latest version of `lmnr` python package is installed. " +
        "`pip install --upgrade lmnr`, or if you are running this command from a virtual " +
        "environment, make sure to activate it. For `uv` users, rerun the command with `uv run`, " +
        `e.g. "uv run npx lmnr-cli dev ${filePathOrModule}"`,
      );
      process.exit(1);
    }
    // Fallback
    const defaultName = options.pythonModule
      ? options.pythonModule.split('.').pop() || 'main'
      : path.basename(filePathOrModule, '.py');
    return {
      functionName: options.function || defaultName,
      params: [],
    };
  }
};

/**
 * Generic metadata discovery dispatcher that routes to language-specific implementations
 */
export const discoverFunctionMetadata = async (
  filePathOrModule: string,
  options: {
    pythonModule?: string;
    function?: string;
    externalPackages?: string[];
    dynamicImportsToSkip?: string[];
  },
): Promise<DiscoveredMetadata> => {
  // If pythonModule is set, we're in Python module mode
  if (options.pythonModule) {
    return await discoverPythonMetadata(filePathOrModule, options);
  }

  // Otherwise check file extension
  const ext = path.extname(filePathOrModule);

  // TypeScript and JavaScript files use the same build/load/select process
  // For JS files, TypeScript metadata extraction will fail, but runtime param extraction works
  if (TS_JS_EXTENSIONS.includes(ext)) {
    return await discoverTypeScriptMetadata(filePathOrModule, options);
  }

  if (ext === '.py') {
    return await discoverPythonMetadata(filePathOrModule, options);
  }

  // Fallback for unsupported file types
  logger.warn(`No metadata discovery available for ${ext} files`);
  return {
    functionName: options.function || path.basename(filePathOrModule, ext),
    params: [],
  };
};
