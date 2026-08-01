import { errorMessage } from "@lmnr-ai/types";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

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

// Bedrock configuration constants
const BEDROCK_BASE_URL_ENV = "ANTHROPIC_BEDROCK_BASE_URL";
const BEDROCK_USE_ENV = "CLAUDE_CODE_USE_BEDROCK";
const BEDROCK_AWS_REGION_ENV = "AWS_REGION";

// Vertex AI configuration constants
const VERTEX_BASE_URL_ENV = "ANTHROPIC_VERTEX_BASE_URL";
const VERTEX_USE_ENV = "CLAUDE_CODE_USE_VERTEX";

// Base-URL keys that must point at our proxy in the flag-settings layer.
export const PROXY_BASE_URL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  FOUNDRY_BASE_URL_ENV,
  BEDROCK_BASE_URL_ENV,
  VERTEX_BASE_URL_ENV,
];

// Provider base-URL keys paired with the flag that turns that provider on. A
// provider can be configured without its base-URL key (e.g. Foundry via
// ANTHROPIC_FOUNDRY_RESOURCE alone), so the flag is what tells us the key is in
// play and must be pinned to the proxy.
const PROVIDER_BASE_URL_ENV_KEYS: [string, string][] = [
  [FOUNDRY_BASE_URL_ENV, FOUNDRY_USE_ENV],
  [BEDROCK_BASE_URL_ENV, BEDROCK_USE_ENV],
  [VERTEX_BASE_URL_ENV, VERTEX_USE_ENV],
];

// Keys that must be blanked in the flag-settings layer: they would otherwise
// redirect the CLI away from our proxy. Removing them from the flag layer is not
// enough — settings layers merge per key, so a lower layer's value would win.
const PROXY_NEUTRALIZED_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  FOUNDRY_RESOURCE_ENV,
];

// Transport-level forward proxies, NOT Anthropic API base URLs. They outrank
// every base URL when resolving our upstream, so reading them from the settings
// layers would make a settings-defined corporate proxy shadow the gateway
// configured right beside it. The pre-existing options.env / process.env
// handling is unchanged; settings simply do not contribute these keys.
const UPSTREAM_SETTINGS_EXCLUDED_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"];

// Track all active proxy instances for cleanup
const activeProxyServers = new Set<any>(); // Set<ProxyServer>
let globalShutdownRegistered = false;

/**
 * Check if environment variable value is truthy (equals '1')
 */
const isTruthyEnv = (value: string | undefined): boolean => value === "1";

/**
 * Load a Claude settings JSON file, or `null` when it could not be read.
 *
 * `null` (unreadable / malformed / not a JSON object) is deliberately distinct
 * from `{}` (a valid but empty settings file): callers that would otherwise
 * REPLACE a user's settings need to know they failed to read it.
 */
const loadSettingsFile = (
  filePath: string,
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed settings are simply absent.
  }
  return null;
};

/**
 * Read a settings file for the on-disk settings LAYERS, where an unreadable
 * file just means we cannot see that layer and must carry on.
 */
const readSettingsFile = (filePath: string): Record<string, unknown> =>
  loadSettingsFile(filePath) ?? {};

const settingsEnvBlock = (
  settings: Record<string, unknown>,
): Record<string, string> => {
  const env = settings.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = String(value);
    }
  }
  return result;
};

/**
 * Read the merged `env` block from Claude Code's on-disk settings layers.
 *
 * Claude Code applies these to the CLI session with HIGHER priority than the
 * subprocess environment, so a user with `ANTHROPIC_BASE_URL` in
 * `~/.claude/settings.json` silently bypasses our proxy. We read them to resolve
 * the real upstream and to detect conflicts.
 *
 * Precedence (highest first): local project, shared project, user.
 *
 * `settingSources` mirrors `options.settingSources` and gates which layers are
 * read: `undefined` means the CLI loads all of them, an array means only those,
 * and `[]` disables on-disk settings entirely. Honoring it matters because
 * reading a layer the CLI was told to ignore would resolve an upstream the CLI
 * never uses, pointing the proxy at an unintended host.
 */
export const readClaudeSettingsEnv = (
  cwd?: string,
  settingSources?: string[],
): Record<string, string> => {
  const sessionCwd = cwd ?? process.cwd();
  const userDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

  // Lowest priority first so higher layers overwrite.
  const layers: [string, string][] = [
    ["user", path.join(userDir, "settings.json")],
    ["project", path.join(sessionCwd, ".claude", "settings.json")],
    ["local", path.join(sessionCwd, ".claude", "settings.local.json")],
  ];

  const merged: Record<string, string> = {};
  for (const [source, filePath] of layers) {
    if (settingSources !== undefined && !settingSources.includes(source)) {
      continue;
    }
    Object.assign(merged, settingsEnvBlock(readSettingsFile(filePath)));
  }
  return merged;
};

/**
 * Build the `--settings` value that forces the CLI through our proxy.
 *
 * Claude Code resolves `env` from its settings layers with higher priority than
 * the subprocess environment, so rewriting `options.env` alone leaves a user with
 * `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` talking straight to their
 * upstream while the proxy sees zero traffic (lmnr#2167). `--settings` is the
 * highest user-controlled layer, so writing the proxy URL there wins without ever
 * touching the user's files on disk.
 *
 * Layers merge per key, so keys we simply omit keep their lower-layer value.
 * Redirecting keys are therefore blanked rather than dropped.
 *
 * Returns the value to assign to `options.settings`, or `null` when the caller's
 * existing value is a file path we could not read (in that case the path must be
 * left alone so the CLI can still resolve it itself).
 */
export const buildProxyFlagSettings = (
  existing: string | Record<string, unknown> | undefined,
  proxyUrl: string,
  cwd?: string,
  settingSources?: string[],
): Record<string, unknown> | null => {
  let settingsObj: Record<string, unknown> = {};

  if (typeof existing === "object" && existing !== null) {
    settingsObj = { ...existing };
  } else if (typeof existing === "string" && existing.trim()) {
    const trimmed = existing.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      settingsObj = parsed as Record<string, unknown>;
    } else {
      const resolved = path.isAbsolute(trimmed)
        ? trimmed
        : path.join(cwd ?? process.cwd(), trimmed);
      // Bail on any value we could not fully read, not just a missing file:
      // emitting a proxy-only blob would drop every setting the user actually
      // configured for this run.
      const loaded = loadSettingsFile(resolved);
      if (loaded === null) {
        return null;
      }
      settingsObj = loaded;
    }
  }

  const envDict: Record<string, string> = { ...settingsEnvBlock(settingsObj) };
  const settingsEnv = readClaudeSettingsEnv(cwd, settingSources);
  const inPlay = (key: string): boolean =>
    key in envDict || key in settingsEnv || process.env[key] !== undefined;

  envDict.ANTHROPIC_BASE_URL = proxyUrl;
  for (const [baseUrlKey, useKey] of PROVIDER_BASE_URL_ENV_KEYS) {
    // Pin a provider base URL when the provider is enabled OR its base URL is
    // already set — never introduce one the user has nothing to do with. Keying
    // only off the base-URL key would miss a provider configured by another
    // route (e.g. Foundry via ANTHROPIC_FOUNDRY_RESOURCE), leaving it with its
    // routing key blanked below and no proxy URL to fall back on.
    const enabled =
      isTruthyEnv(envDict[useKey]) ||
      isTruthyEnv(settingsEnv[useKey]) ||
      isTruthyEnv(process.env[useKey]);
    if (enabled || inPlay(baseUrlKey)) {
      envDict[baseUrlKey] = proxyUrl;
    }
    // The Foundry resource is mutually exclusive with the base URL we just
    // pinned — the CLI hard-fails ("baseURL and resource are mutually
    // exclusive") if both are live. Blank it whenever Foundry is in play, even
    // when the resource only exists in the process env, since the flag layer is
    // the only place we can override it for the subprocess.
    if (baseUrlKey === FOUNDRY_BASE_URL_ENV && envDict[baseUrlKey] === proxyUrl) {
      envDict[FOUNDRY_RESOURCE_ENV] = "";
    }
  }
  for (const key of PROXY_NEUTRALIZED_ENV_KEYS) {
    if (key in settingsEnv || key in envDict || process.env[key] !== undefined) {
      envDict[key] = "";
    }
  }

  return { ...settingsObj, env: envDict };
};

/**
 * Read region for a given profile from ~/.aws/config.
 */
const getRegionFromAwsConfig = (profile: string): string | null => {
  const configPath = path.join(os.homedir(), ".aws", "config");
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }

  const profileHeader =
    profile === "default" ? "default" : `profile ${profile}`;
  const escapedHeader = profileHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\[${escapedHeader}\\][^\\[]*?^\\s*region\\s*=\\s*([^\\s\\n]+)`,
    "ms",
  );
  const match = content.match(regex);
  return match ? match[1] : null;
};

/**
 * Resolve target URL from environment dictionary with process.env fallback.
 *
 * This is the single source of truth for determining the target URL for the proxy.
 *
 * Resolution order (highest to lowest priority):
 * 1. HTTPS_PROXY - if set, use as target (our proxy will forward to it)
 * 2. HTTP_PROXY - if set, use as target (our proxy will forward to it)
 * 3. Third-party provider URLs (e.g., Foundry, Bedrock):
 *    - If CLAUDE_CODE_USE_FOUNDRY is truthy:
 *      - Use ANTHROPIC_FOUNDRY_BASE_URL, or
 *      - Construct from ANTHROPIC_FOUNDRY_RESOURCE
 *    - If CLAUDE_CODE_USE_BEDROCK is truthy:
 *      - Use ANTHROPIC_BEDROCK_BASE_URL, or
 *      - Construct from AWS_REGION env var, or
 *      - Construct by reading region from ~/.aws/config via AWS_PROFILE
 *    - If CLAUDE_CODE_USE_VERTEX is truthy:
 *      - Use ANTHROPIC_VERTEX_BASE_URL, or
 *      - Construct from CLOUD_ML_REGION and ANTHROPIC_VERTEX_PROJECT_ID
 * 4. ANTHROPIC_BASE_URL - standard Anthropic API base URL
 * 5. Fall back to default (https://api.anthropic.com)
 *
 * For each environment variable, checks envDict first, then process.env, then
 * Claude Code's on-disk settings `env` block. The settings layer is checked last
 * as a source for the *upstream* URL, but note it wins over process env inside
 * the CLI itself — see `buildProxyFlagSettings`.
 *
 * @param envDict - Dictionary of environment variables (e.g., from options.env)
 * @param fallback - Fallback URL if no other source found (default: DEFAULT_ANTHROPIC_BASE_URL)
 * @param cwd - Session root used to locate project settings (`options.cwd`)
 * @returns Resolved target URL, or null if provider is misconfigured
 */
export const resolveTargetUrlFromEnv = (
  envDict: Record<string, string | undefined>,
  fallback: string = DEFAULT_ANTHROPIC_BASE_URL,
  cwd?: string,
  settingSources?: string[],
): string | null => {
  const settingsEnv = readClaudeSettingsEnv(cwd, settingSources);

  // Helper: options.env, then process.env, then Claude settings env.
  // HTTP_PROXY / HTTPS_PROXY are deliberately NOT taken from settings — they are
  // forward proxies rather than API bases and outrank every base URL below, so a
  // settings-defined corporate proxy would shadow the gateway next to it.
  const getEnvValue = (key: string): string | undefined => {
    const value = envDict[key] || process.env[key];
    if (value || UPSTREAM_SETTINGS_EXCLUDED_ENV_KEYS.includes(key)) {
      return value;
    }
    return settingsEnv[key];
  };

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

  // 3b. Check for Bedrock
  const bedrockEnabled = isTruthyEnv(getEnvValue(BEDROCK_USE_ENV));
  if (bedrockEnabled) {
    const bedrockBaseUrl = getEnvValue(BEDROCK_BASE_URL_ENV);
    if (bedrockBaseUrl) {
      return bedrockBaseUrl.replace(/\/$/, "");
    }

    let region = getEnvValue(BEDROCK_AWS_REGION_ENV);
    if (!region) {
      const awsProfile = getEnvValue("AWS_PROFILE") || "default";
      region = getRegionFromAwsConfig(awsProfile) ?? undefined;
    }

    if (region) {
      return `https://bedrock-runtime.${region}.amazonaws.com`;
    }

    logger.error(
      `${BEDROCK_USE_ENV} is set but could not determine AWS region. ` +
        `Set ${BEDROCK_AWS_REGION_ENV} or configure a region ` +
        "in ~/.aws/config for the active profile.",
    );
    return null;
  }

  // 3c. Check for Vertex AI
  const vertexEnabled = isTruthyEnv(getEnvValue(VERTEX_USE_ENV));
  if (vertexEnabled) {
    // unlike for Foundry or Bedrock, we don't parse the project or region config, because
    // they affect the URL path, not the base URL, so CC can handle this part internally
    const vertexBaseUrl = getEnvValue(VERTEX_BASE_URL_ENV);
    if (vertexBaseUrl) {
      return vertexBaseUrl.replace(/\/$/, "");
    }
    return `https://aiplatform.googleapis.com/v1`;
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
export const getEnvVarsToRemove = (
  envDict: Record<string, string | undefined>,
  cwd?: string,
  settingSources?: string[],
): string[] => {
  const toRemove: string[] = ["HTTPS_PROXY", "HTTP_PROXY"];

  const settingsEnv = readClaudeSettingsEnv(cwd, settingSources);

  // Helper: envDict, then process.env, then Claude settings env. Settings are
  // included because Foundry is often enabled only there, and the resource is
  // mutually exclusive with the base URL we set — leaving it in options.env
  // makes the CLI hard-fail.
  const getEnvValue = (key: string): string | undefined =>
    envDict[key] || process.env[key] || settingsEnv[key];

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
): Promise<number | null> =>
  new Promise((resolve) => {
    let currentAttempt = 0;

    const tryPort = (port: number) => {
      const server = net.createServer();

      server.once("error", () => {
        server.close();
        currentAttempt++;
        if (currentAttempt < attempts) {
          tryPort(startPort + currentAttempt);
        } else {
          resolve(null);
        }
      });

      server.once("listening", () => {
        server.close(() => {
          resolve(port);
        });
      });

      server.listen(port, "127.0.0.1");
    };

    tryPort(startPort);
  });

/**
 * Wait for a port to be available
 */
const waitForPort = (
  port: number,
  timeoutMs: number = 5000,
): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const checkPort = () => {
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }

      const socket = new net.Socket();

      socket.setTimeout(200);

      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.once("timeout", () => {
        socket.destroy();
        setTimeout(checkPort, 100);
      });

      socket.once("error", () => {
        socket.destroy();
        setTimeout(checkPort, 100);
      });

      socket.connect(port, "127.0.0.1");
    };

    checkPort();
  });

/**
 * Register global cleanup on process exit for all active proxies
 */
const registerGlobalProxyShutdown = () => {
  if (!globalShutdownRegistered) {
    process.on("exit", () => {
      logger.debug('process.on("exit") called - stopping all active proxies');
      for (const proxyServer of activeProxyServers) {
        try {
          proxyServer.stopServer();
        } catch (e) {
          logger.debug(
            `Failed to stop proxy: ${errorMessage(e)}`,
          );
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
  cwd,
  settingSources,
  targetUrl: resolvedTargetUrl,
}: {
  env: Record<string, string | undefined>;
  cwd?: string;
  settingSources?: string[];
  targetUrl?: string | null;
}): Promise<ProxyInstance | null> => {
  try {
    const port = await findAvailablePort(
      DEFAULT_CC_PROXY_PORT,
      CC_PROXY_PORT_ATTEMPTS,
    );
    if (port === null) {
      logger.warn("Unable to allocate port for cc-proxy.");
      return null;
    }

    // Prefer the caller's already-resolved upstream. Re-resolving here without
    // the session cwd would miss a gateway configured only in project or local
    // settings, and the proxy would forward to the default Anthropic API while
    // ANTHROPIC_ORIGINAL_BASE_URL pointed at the gateway.
    const targetUrl =
      resolvedTargetUrl ??
      resolveTargetUrlFromEnv(env, undefined, cwd, settingSources);
    if (!targetUrl) {
      logger.warn(
        "Unable to resolve target URL for cc-proxy (provider misconfigured).",
      );
      return null;
    }

    logger.debug(
      `Creating proxy instance on port ${port} targeting: ${targetUrl}`,
    );

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
      logger.warn(
        `Unable to start cc-proxy: ${errorMessage(e)}`,
      );
      return null;
    }
  } catch (e) {
    logger.warn(
      `Failed to create proxy instance: ${errorMessage(e)}`,
    );
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
    logger.debug(
      `Failed to stop proxy instance: ${errorMessage(e)}`,
    );
  }
};

/**
 * Force stop all active proxy servers
 * Used during shutdown to ensure cleanup
 */
export const forceReleaseProxy = (): void => {
  logger.debug(
    `Force stopping all ${activeProxyServers.size} active proxy servers`,
  );
  for (const proxyServer of activeProxyServers) {
    try {
      proxyServer.stopServer();
    } catch (e) {
      logger.debug(
        `Failed to stop proxy: ${errorMessage(e)}`,
      );
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
  if (
    !currentSpan ||
    (!currentSpan.spanContext().isRemote && !currentSpan.isRecording())
  ) {
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
export const setTraceToProxyInstance = async (
  instance: ProxyInstance | null,
): Promise<void> => {
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
      `Unable to set trace context to proxy on port ${instance.port}: ` + errorMessage(e),
    );
  }
};
