import { errorMessage } from "@lmnr-ai/types";

import { EXIT_GENERIC, EXIT_NOT_LOGGED_IN } from "../commands/auth";
import { readCredentials } from "../commands/auth/credentials";
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

// Precedence (highest first):
//   1. --project-api-key flag (`options.projectApiKey`)
//   2. LMNR_PROJECT_API_KEY env var
//   3. credentials file ~/.lmnr/credentials.json
//   4. throw (caller prints actionable message + exits)
//
// Same precedence for baseUrl. We treat env vars as having priority over the
// credentials file's baseUrl: CI workflows that source the prod base URL via
// env should not be overridden by a stale local dev credential file.
export const resolveAuth = async (
  options: AuthResolveOptions,
): Promise<ResolvedAuth> => {
  if (options.projectApiKey) {
    return {
      projectApiKey: options.projectApiKey,
      baseUrl: options.baseUrl ?? process.env.LMNR_BASE_URL,
      port: options.port,
    };
  }

  if (process.env.LMNR_PROJECT_API_KEY) {
    return {
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      baseUrl: options.baseUrl ?? process.env.LMNR_BASE_URL,
      port: options.port,
    };
  }

  const creds = await readCredentials();
  if (creds) {
    return {
      projectApiKey: creds.projectApiKey,
      baseUrl: options.baseUrl ?? process.env.LMNR_BASE_URL ?? creds.baseUrl,
      port: options.port,
    };
  }

  const err = new Error(
    "No Laminar credentials found. Run `lmnr-cli auth login` or set LMNR_PROJECT_API_KEY.",
  );
  // Sentinel — callers map this to exit code 6 (EXIT_NOT_LOGGED_IN).
  (err as { code?: string }).code = "NOT_LOGGED_IN";
  throw err;
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
