import { spawn } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';

/**
 * Proxies execution to the lmnr-cli package.
 * This ensures lmnr-cli is accessible when @lmnr-ai/lmnr is installed,
 * without requiring users to explicitly install lmnr-cli as a direct dependency.
 *
 * @param args - Arguments to pass to lmnr-cli (e.g., ['dev', 'file.ts', '--port', '8080'])
 */
export function proxyToLmnrCli(args: string[]): void {
  // Create require function for resolving modules
  const require = createRequire(import.meta.url);

  // Try to resolve the lmnr-cli package
  let cliPath: string;
  try {
    const cliPackagePath = require.resolve('lmnr-cli/package.json');
    const cliDir = dirname(cliPackagePath);
    cliPath = join(cliDir, 'dist/index.cjs');
  } catch {
    console.error(
      "\x1b[31m%s\x1b[0m",  // Red text
      "\nError: lmnr-cli package not found.\n\n" +
      "This is unexpected since lmnr-cli is a dependency of @lmnr-ai/lmnr.\n" +
      "Please report this issue at https://github.com/lmnr-ai/lmnr-ts/issues\n",
    );
    process.exit(1);
  }

  // Spawn the lmnr-cli process with all arguments
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(
      "\x1b[31m%s\x1b[0m",  // Red text
      `\nError: Failed to spawn lmnr-cli process.\n\n` +
      `Details: ${error.message}\n\n` +
      `Please report this issue at https://github.com/lmnr-ai/lmnr-ts/issues\n`,
    );
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
