import { InitializeOptions } from "../interfaces";
import { startTracing } from "../tracing";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { InitializationError } from "../errors";

export let _configuration: InitializeOptions | undefined;

/**
 * Initializes the SDK.
 * Must be called once before any other SDK methods.
 *
 * @param options - The options to initialize the SDK. See the {@link InitializeOptions} for details.
 * @throws {InitializationError} if the configuration is invalid or if failed to fetch feature data.
 */
export let initializeTracing = (options: InitializeOptions) => {
  if (_configuration) {
    return;
  }

  if (!options.baseUrl) {
    options.baseUrl =
      process.env.LMNR_BASE_URL || "https://api.lmnr.ai:8443";
  }
  if (!options.apiKey) {
    options.apiKey = process.env.LMNR_PROJECT_API_KEY;
  }
  if (options.apiKey && typeof options.apiKey !== "string") {
    throw new InitializationError('"apiKey" must be a string');
  }

  if (!options.appName) {
    options.appName = process.env.npm_package_name;
  }

  _configuration = Object.freeze(options);

  if (options.logLevel) {
    diag.setLogger(
      new DiagConsoleLogger(),
      logLevelToOtelLogLevel(options.logLevel),
    );
  }

  if (!options.silenceInitializationMessage) {
    console.log(
      `Laminar exporting traces to ${
        _configuration.exporter ? "a custom exporter" : _configuration.baseUrl
      }`,
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
