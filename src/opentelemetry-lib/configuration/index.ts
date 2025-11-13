import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

import { InitializeOptions } from "../interfaces";
import { startTracing } from "../tracing";

export let _configuration: InitializeOptions | undefined;

/**
 * Initializes the SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions}
 * for details.
 * @throws {InitializationError} if the configuration is invalid or if failed to fetch
 * feature data.
 */
export const initializeTracing = (options: InitializeOptions) => {
  if (_configuration) {
    return;
  }

  // Only set defaults if not already provided and if we have an API key
  // (when using OTEL env vars, we don't need a baseUrl or API key)
  const apiKey = options.apiKey ?? process.env.LMNR_PROJECT_API_KEY;
  if (!options.baseUrl && apiKey) {
    options.baseUrl = process.env.LMNR_BASE_URL || "https://api.lmnr.ai:8443";
  }
  if (!options.apiKey) {
    options.apiKey = apiKey;
  }

  _configuration = Object.freeze(options);

  if (options.logLevel) {
    diag.setLogger(
      new DiagConsoleLogger(),
      {
        logLevel: logLevelToOtelLogLevel(options.logLevel),
        suppressOverrideMessage: true,
      },
    );
  }

  startTracing(_configuration);
};

const logLevelToOtelLogLevel = (
  logLevel: "debug" | "info" | "warn" | "error",
) => {
  switch (logLevel) {
    case "debug":
      return DiagLogLevel.DEBUG;
    case "info":
      return DiagLogLevel.INFO;
    case "warn":
      return DiagLogLevel.WARN;
    case "error":
      return DiagLogLevel.ERROR;
  }
};

export const _resetConfiguration = () => {
  _configuration = undefined;
};
