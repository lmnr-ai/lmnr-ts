import { errorMessage } from "@lmnr-ai/types";

import { EXIT_GENERIC, EXIT_NOT_LOGGED_IN } from "../commands/auth";
import { initializeLogger } from "./logger";
import { outputJsonError } from "./output";

const logger = initializeLogger();

export interface ResolvedAuth {
  projectApiKey: string;
  baseUrl?: string;
  port?: number;
}

export interface AuthResolveOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

// Precedence for the API KEY (highest first):
//   1. --project-api-key flag (`options.projectApiKey`)
//   2. LMNR_PROJECT_API_KEY env var
//   3. throw (caller prints actionable message + exits)
//
// baseUrl: `--base-url` flag > LMNR_BASE_URL env.
//
// Returns a Promise (not `async`) so existing `await resolveAuth(...)` call
// sites keep working without a no-op await inside the body.
export const resolveAuth = (
  options: AuthResolveOptions,
): Promise<ResolvedAuth> => {
  const baseUrl = options.baseUrl ?? process.env.LMNR_BASE_URL;

  if (options.projectApiKey) {
    return Promise.resolve({ projectApiKey: options.projectApiKey, baseUrl, port: options.port });
  }

  if (process.env.LMNR_PROJECT_API_KEY) {
    return Promise.resolve({
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      baseUrl,
      port: options.port,
    });
  }

  const err = new Error(
    "No Laminar project API key found. Pass --project-api-key or set" +
      " LMNR_PROJECT_API_KEY (run `lmnr-cli setup` to write it to ./.env).",
  );
  // Sentinel — callers map this to exit code 6 (EXIT_NOT_LOGGED_IN).
  (err as { code?: string }).code = "NOT_LOGGED_IN";
  return Promise.reject(err);
};

// Shared "resolve auth or die" wrapper. Use this from every command handler
// instead of inline try/catch + `let auth;` — TS narrows the return to
// `Promise<ResolvedAuth>` (no undefined leak) because the helper's `Promise<never>`
// catch branch + the `process.exit` return type combine to a sound type.
export const resolveAuthOrExit = async (
  options: AuthResolveOptions,
): Promise<ResolvedAuth> => {
  try {
    return await resolveAuth(options);
  } catch (err) {
    if (options.json) outputJsonError(err);
    logger.error(errorMessage(err));
    process.exit(
      (err as { code?: string })?.code === "NOT_LOGGED_IN" ? EXIT_NOT_LOGGED_IN : EXIT_GENERIC,
    );
  }
};
