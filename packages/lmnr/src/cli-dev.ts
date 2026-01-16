#!/usr/bin/env node

/**
 * Wrapper binary that proxies to the lmnr-cli package.
 * This ensures the lmnr-cli binary is accessible when @lmnr-ai/lmnr is installed,
 * without requiring users to explicitly install lmnr-cli as a direct dependency.
 */

import { proxyToLmnrCli } from './cli/proxy-to-lmnr-cli.js';

// Pass all arguments to lmnr-cli (skip 'node' and script path)
proxyToLmnrCli(process.argv.slice(2));
