import * as net from "net";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { runServer, setCurrentTrace, stopServer } from "@lmnr-ai/claude-code-proxy";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { SPAN_IDS_PATH, SPAN_PATH } from "../../tracing/attributes";
import { LaminarContextManager } from "../../tracing/context";

const logger = initializeLogger();

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_CC_PROXY_PORT = 45667;
const CC_PROXY_PORT_ATTEMPTS = 5;

// Module-level state for proxy management
let ccProxyPort: number | null = null;
let ccProxyBaseUrl: string | null = null;
let ccProxyTargetUrl: string | null = null;
let ccProxyShutdownRegistered = false;

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
 * Stop the claude-code proxy server (internal, no lock)
 */
function stopCcProxyLocked() {
  try {
    stopServer();
  } catch (e) {
    logger.debug(`Unable to stop cc-proxy: ${e}`);
  }

  if (ccProxyTargetUrl) {
    process.env.ANTHROPIC_BASE_URL = ccProxyTargetUrl;
  }

  ccProxyPort = null;
  ccProxyBaseUrl = null;
}

/**
 * Stop the claude-code proxy server
 */
function stopCcProxy() {
  stopCcProxyLocked();
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
 * Start the claude-code proxy server
 */
export async function startProxy(): Promise<string | null> {
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
  } catch (exc) {
    logger.warn(`Unable to start cc-proxy: ${exc}`);
    return null;
  }

  const isReady = await waitForPort(port);
  if (!isReady) {
    logger.warn(`cc-proxy failed to start on port ${port}`);
    stopServer();
    return null;
  }

  const proxyBaseUrl = `http://127.0.0.1:${port}`;
  ccProxyPort = port;
  ccProxyBaseUrl = proxyBaseUrl;
  process.env.ANTHROPIC_BASE_URL = proxyBaseUrl;
  registerProxyShutdown();

  logger.info(`Started claude proxy server on: ${proxyBaseUrl}`);
  return proxyBaseUrl;
}

/**
 * Release/stop the claude-code proxy server
 */
export function releaseProxy(): void {
  stopCcProxyLocked();
  logger.debug("Released claude proxy server");
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
  });
}

