import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import * as net from "net";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { SPAN_IDS_PATH, SPAN_PATH } from "../../tracing/attributes";
import { LaminarContextManager } from "../../tracing/context";

const logger = initializeLogger();

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_CC_PROXY_PORT = 45667;
const CC_PROXY_PORT_ATTEMPTS = 50;

// Foundry configuration constants
const FOUNDRY_BASE_URL_ENV = "ANTHROPIC_FOUNDRY_BASE_URL";
const FOUNDRY_RESOURCE_ENV = "ANTHROPIC_FOUNDRY_RESOURCE";
const FOUNDRY_USE_ENV = "CLAUDE_CODE_USE_FOUNDRY";

// Track all active proxy instances for cleanup
const activeProxyServers = new Set<any>(); // Set<ProxyServer>
let globalShutdownRegistered = false;

/**
 * Check if environment variable value is truthy (equals '1')
 */
const isTruthyEnv = (value: string | undefined): boolean => value === "1";

/**
 * Resolve target URL from environment dictionary with process.env fallback.
 *
 * This is the single source of truth for determining the target URL for the proxy.
 *
 * Resolution order (highest to lowest priority):
 * 1. HTTPS_PROXY - if set, use as target (our proxy will forward to it)
 * 2. HTTP_PROXY - if set, use as target (our proxy will forward to it)
 * 3. Third-party provider URLs (e.g., Foundry):
 *    - If CLAUDE_CODE_USE_FOUNDRY is truthy:
 *      - Use ANTHROPIC_FOUNDRY_BASE_URL, or
 *      - Construct from ANTHROPIC_FOUNDRY_RESOURCE
 * 4. ANTHROPIC_BASE_URL - standard Anthropic API base URL
 * 5. Fall back to default (https://api.anthropic.com)
 *
 * For each environment variable, checks envDict first, then process.env as fallback.
 *
 * @param envDict - Dictionary of environment variables (e.g., from options.env)
 * @param fallback - Fallback URL if no other source found (default: DEFAULT_ANTHROPIC_BASE_URL)
 * @returns Resolved target URL, or null if provider is misconfigured
 */
export const resolveTargetUrlFromEnv = (
  envDict: Record<string, string | undefined>,
  fallback: string = DEFAULT_ANTHROPIC_BASE_URL,
): string | null => {
  // Helper to get value from envDict first, then process.env
  const getEnvValue = (key: string): string | undefined => envDict[key] || process.env[key];

  // 1. Check for HTTPS_PROXY (highest priority)
  const httpsProxy = getEnvValue("HTTPS_PROXY");
  if (httpsProxy) {
    return httpsProxy.replace(/\/$/, "");
  }

  // 2. Check for HTTP_PROXY
  const httpProxy = getEnvValue("HTTP_PROXY");
  if (httpProxy) {
    return httpProxy.replace(/\/$/, "");
  }

  // 3. Check for third-party providers (Foundry)
  const foundryEnabled = isTruthyEnv(getEnvValue(FOUNDRY_USE_ENV));
  if (foundryEnabled) {
    // Try to get Foundry base URL first
    const foundryBaseUrl = getEnvValue(FOUNDRY_BASE_URL_ENV);
    if (foundryBaseUrl) {
      return foundryBaseUrl.replace(/\/$/, "");
    }

    // Try to construct from resource
    const foundryResource = getEnvValue(FOUNDRY_RESOURCE_ENV);
    if (foundryResource) {
      return `https://${foundryResource}.services.ai.azure.com/anthropic`;
    }

    // Foundry is enabled but misconfigured
    logger.error(
      `${FOUNDRY_USE_ENV} is set but neither ${FOUNDRY_BASE_URL_ENV} ` +
      `nor ${FOUNDRY_RESOURCE_ENV} is configured. ` +
      `Microsoft Foundry requires one of these values.`,
    );
    return null;
  }

  // 4. Check for ANTHROPIC_BASE_URL
  const anthropicBaseUrl = getEnvValue("ANTHROPIC_BASE_URL");
  if (anthropicBaseUrl) {
    return anthropicBaseUrl.replace(/\/$/, "");
  }

  // 5. Use fallback
  return fallback;
};

/**
 * Get environment variables to remove from subprocess after resolving target URL.
 * These are variables that should not be passed to the subprocess because they
 * would interfere with our proxy setup.
 *
 * @param envDict - Dictionary of environment variables
 * @returns Array of environment variable keys to remove
 */
export const getEnvVarsToRemove = (envDict: Record<string, string | undefined>): string[] => {
  const toRemove: string[] = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
  ];

  // Helper to get value from envDict first, then process.env
  const getEnvValue = (key: string): string | undefined => envDict[key] || process.env[key];

  // Remove FOUNDRY_RESOURCE if Foundry is enabled
  // (it's mutually exclusive with ANTHROPIC_BASE_URL which we'll set)
  const foundryEnabled = isTruthyEnv(getEnvValue(FOUNDRY_USE_ENV));
  if (foundryEnabled) {
    toRemove.push(FOUNDRY_RESOURCE_ENV);
  }

  return toRemove;
};

/**
 * Find an available port starting from the given port
 */
const findAvailablePort = (
  startPort: number,
  attempts: number,
): Promise<number | null> => new Promise((resolve) => {
  let currentAttempt = 0;

  const tryPort = (port: number) => {
    const server = net.createServer();

    server.once('error', () => {
      server.close();
      currentAttempt++;
      if (currentAttempt < attempts) {
        tryPort(startPort + currentAttempt);
      } else {
        resolve(null);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(port);
      });
    });

    server.listen(port, '127.0.0.1');
  };

  tryPort(startPort);
});

/**
 * Wait for a port to be available
 */
const waitForPort = (
  port: number,
  timeoutMs: number = 5000,
): Promise<boolean> => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;

  const checkPort = () => {
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }

    const socket = new net.Socket();

    socket.setTimeout(200);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      setTimeout(checkPort, 100);
    });

    socket.once('error', () => {
      socket.destroy();
      setTimeout(checkPort, 100);
    });

    socket.connect(port, '127.0.0.1');
  };

  checkPort();
});

/**
 * Register global cleanup on process exit for all active proxies
 */
const registerGlobalProxyShutdown = () => {
  if (!globalShutdownRegistered) {
    process.on('exit', () => {
      logger.debug('process.on("exit") called - stopping all active proxies');
      for (const proxyServer of activeProxyServers) {
        try {
          proxyServer.stopServer();
        } catch (e) {
          logger.debug(`Failed to stop proxy: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      activeProxyServers.clear();
    });
    globalShutdownRegistered = true;
  }
};

/**
 * Interface for a proxy instance with its metadata
 */
export interface ProxyInstance {
  server: any; // ProxyServer
  baseUrl: string;
  port: number;
  targetUrl: string;
}

/**
 * Create and start a new claude-code proxy server instance
 * Each call creates an independent proxy on a unique port
 */
export const createProxyInstance = async ({
  env,
}: {
  env: Record<string, string | undefined>;
}): Promise<ProxyInstance | null> => {
  try {
    const port = await findAvailablePort(DEFAULT_CC_PROXY_PORT, CC_PROXY_PORT_ATTEMPTS);
    if (port === null) {
      logger.warn("Unable to allocate port for cc-proxy.");
      return null;
    }

    // Resolve target URL using the priority order
    const targetUrl = resolveTargetUrlFromEnv(env);
    if (!targetUrl) {
      logger.warn("Unable to resolve target URL for cc-proxy (provider misconfigured).");
      return null;
    }

    logger.debug(`Creating proxy instance on port ${port} targeting: ${targetUrl}`);

    try {
      // Dynamically import ProxyServer class
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ProxyServer } = require("@lmnr-ai/claude-code-proxy");

      const proxyServer = new ProxyServer(port);
      proxyServer.runServer(targetUrl);

      const isReady = await waitForPort(port);
      if (!isReady) {
        logger.warn(`cc-proxy failed to start on port ${port}`);
        proxyServer.stopServer();
        return null;
      }

      const proxyBaseUrl = `http://127.0.0.1:${port}`;

      // Track this proxy for cleanup
      activeProxyServers.add(proxyServer);
      registerGlobalProxyShutdown();

      logger.info(`Started claude proxy server on: ${proxyBaseUrl}`);

      return {
        server: proxyServer,
        baseUrl: proxyBaseUrl,
        port,
        targetUrl,
      };
    } catch (e) {
      logger.warn(`Unable to start cc-proxy: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  } catch (e) {
    logger.warn(`Failed to create proxy instance: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/**
 * Stop a specific proxy instance
 */
export const stopProxyInstance = (instance: ProxyInstance | null): void => {
  if (!instance) {
    return;
  }

  try {
    logger.debug(`Stopping proxy instance on port ${instance.port}`);
    instance.server.stopServer();
    activeProxyServers.delete(instance.server);
  } catch (e) {
    logger.debug(`Failed to stop proxy instance: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Force stop all active proxy servers
 * Used during shutdown to ensure cleanup
 */
export const forceReleaseProxy = (): void => {
  logger.debug(`Force stopping all ${activeProxyServers.size} active proxy servers`);
  for (const proxyServer of activeProxyServers) {
    try {
      proxyServer.stopServer();
    } catch (e) {
      logger.debug(`Failed to stop proxy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  activeProxyServers.clear();
};

/**
 * Get the current span context payload for proxy
 */
const getSpanContextPayload = (): {
  trace_id: string;
  span_id: string;
  project_api_key: string;
  span_ids_path: string[];
  span_path: string[];
  laminar_url: string;
} | null => {
  const currentSpan = trace.getSpan(LaminarContextManager.getContext());
  if (!currentSpan || !currentSpan.spanContext().isRemote && !currentSpan.isRecording()) {
    return null;
  }

  const spanContext = currentSpan.spanContext();
  if (!spanContext || !spanContext.traceId) {
    return null;
  }

  let spanIdsPath: string[] = [];
  let spanPath: string[] = [];

  // Try to extract span path attributes from readable span
  try {
    const readableSpan = currentSpan as unknown as ReadableSpan;
    if (readableSpan.attributes) {
      const idsPath = readableSpan.attributes[SPAN_IDS_PATH];
      const path = readableSpan.attributes[SPAN_PATH];

      if (Array.isArray(idsPath)) {
        spanIdsPath = idsPath as string[];
      }
      if (Array.isArray(path)) {
        spanPath = path as string[];
      }
    }
  } catch {
    // If we can't access attributes, continue with empty arrays
  }

  const projectApiKey = Laminar.getProjectApiKey();
  const laminarUrl = Laminar.getHttpUrl();

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    project_api_key: projectApiKey || "",
    span_ids_path: spanIdsPath,
    span_path: spanPath,
    laminar_url: laminarUrl || "https://api.lmnr.ai",
  };
};

/**
 * Set the trace context for a specific proxy instance
 */
export const setTraceToProxyInstance = async (instance: ProxyInstance | null): Promise<void> => {
  if (!instance) {
    return;
  }

  const payload = getSpanContextPayload();
  if (!payload) {
    return;
  }

  try {
    await instance.server.setCurrentTrace({
      traceId: payload.trace_id,
      spanId: payload.span_id,
      projectApiKey: payload.project_api_key,
      spanIdsPath: payload.span_ids_path,
      spanPath: payload.span_path,
      laminarUrl: payload.laminar_url,
    });
    logger.debug(`Set trace context to proxy on port ${instance.port}`);
  } catch (e: any) {
    logger.debug(
      `Unable to set trace context to proxy on port ${instance.port}: ` +
      (e instanceof Error ? e.message : String(e)),
    );
  }
};
