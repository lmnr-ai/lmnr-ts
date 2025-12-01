import { runServer, setCurrentTrace, stopServer } from "@lmnr-ai/claude-code-proxy";
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
const CC_PROXY_PORT_ATTEMPTS = 5;

// Module-level state for proxy management
let ccProxyBaseUrl: string | null = null;
let ccProxyTargetUrl: string | null = null;
let ccProxyShutdownRegistered = false;
let ccProxyRefCount = 0;
let ccProxyStartupPromise: Promise<string | null> | null = null;

/**
 * Find an available port starting from the given port
 */
function findAvailablePort(startPort: number, attempts: number): Promise<number | null> {
  return new Promise((resolve) => {
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
}

/**
 * Wait for a port to be available
 */
function waitForPort(port: number, timeoutMs: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
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
}

/**
 * Stop the claude-code proxy server
 */
function stopCcProxy() {
  try {
    stopServer();
  } catch (e) {
    logger.debug(`Unable to stop cc-proxy: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (ccProxyTargetUrl) {
    process.env.ANTHROPIC_BASE_URL = ccProxyTargetUrl;
  }

  ccProxyBaseUrl = null;
  ccProxyTargetUrl = null;
  ccProxyRefCount = 0;
  ccProxyStartupPromise = null;
}

/**
 * Register cleanup on process exit
 */
function registerProxyShutdown() {
  if (!ccProxyShutdownRegistered) {
    process.on('exit', () => {
      stopCcProxy();
    });
    ccProxyShutdownRegistered = true;
  }
}

/**
 * Get the current proxy base URL if running
 */
export function getProxyBaseUrl(): string | null {
  return ccProxyBaseUrl;
}

/**
 * Start the claude-code proxy server with reference counting
 */
export async function startProxy(): Promise<string | null> {
  // If there's an ongoing startup, wait for it to complete
  if (ccProxyStartupPromise !== null) {
    logger.debug("Waiting for ongoing proxy startup to complete");
    await ccProxyStartupPromise;
  }

  // After waiting (or if there was no ongoing startup), check if proxy is running
  if (ccProxyBaseUrl !== null) {
    ccProxyRefCount++;
    logger.debug(`Reusing existing proxy, ref count: ${ccProxyRefCount}`);
    return ccProxyBaseUrl;
  }

  // Start the proxy - create promise to prevent concurrent startups
  ccProxyStartupPromise = (async () => {
    try {
      const port = await findAvailablePort(DEFAULT_CC_PROXY_PORT, CC_PROXY_PORT_ATTEMPTS);
      if (port === null) {
        logger.warn("Unable to allocate port for cc-proxy.");
        return null;
      }

      const targetUrl =
        ccProxyTargetUrl ||
        process.env.ANTHROPIC_ORIGINAL_BASE_URL ||
        process.env.ANTHROPIC_BASE_URL ||
        DEFAULT_ANTHROPIC_BASE_URL;

      ccProxyTargetUrl = targetUrl;
      process.env.ANTHROPIC_ORIGINAL_BASE_URL = targetUrl;

      try {
        runServer(targetUrl, port);
      } catch (e) {
        logger.warn(`Unable to start cc-proxy: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      const isReady = await waitForPort(port);
      if (!isReady) {
        logger.warn(`cc-proxy failed to start on port ${port}`);
        stopServer();
        return null;
      }

      const proxyBaseUrl = `http://127.0.0.1:${port}`;
      ccProxyBaseUrl = proxyBaseUrl;
      ccProxyRefCount = 1;
      process.env.ANTHROPIC_BASE_URL = proxyBaseUrl;
      registerProxyShutdown();

      logger.info(`Started claude proxy server on: ${proxyBaseUrl}`);
      return proxyBaseUrl;
    } finally {
      // Clear the startup promise when done (success or failure)
      ccProxyStartupPromise = null;
    }
  })();

  return ccProxyStartupPromise;
}

/**
 * Release/stop the claude-code proxy server with reference counting
 */
export function releaseProxy(): void {
  if (ccProxyRefCount > 0) {
    ccProxyRefCount--;
    logger.debug(`Decremented proxy ref count to: ${ccProxyRefCount}`);
  }

  // Only stop the proxy when ref count reaches 0
  if (ccProxyRefCount === 0 && ccProxyBaseUrl !== null) {
    stopCcProxy();
    logger.debug("Stopped claude proxy server (ref count reached 0)");
  }
}

/**
 * Force stop the claude-code proxy server, ignoring reference count
 * Used during shutdown to ensure cleanup
 */
export function forceReleaseProxy(): void {
  if (ccProxyBaseUrl !== null) {
    stopCcProxy();
    logger.debug("Force stopped claude proxy server");
  }
}

/**
 * Get the current span context payload for proxy
 */
function getSpanContextPayload(): {
  trace_id: string;
  span_id: string;
  project_api_key: string;
  span_ids_path: string[];
  span_path: string[];
  laminar_url: string;
} | null {
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
}

/**
 * Publish the current span context to the proxy server
 */
export function setTraceToProxy(): void {
  const payload = getSpanContextPayload();
  if (!payload) {
    return;
  }

  setCurrentTrace({
    traceId: payload.trace_id,
    spanId: payload.span_id,
    projectApiKey: payload.project_api_key,
    spanIdsPath: payload.span_ids_path,
    spanPath: payload.span_path,
    laminarUrl: payload.laminar_url,
  }).catch((error) => {
    logger.debug(`Failed to set trace context to proxy: ${error}`);
  }).finally(() => {
    logger.debug("Set trace context to proxy");
  });
}

