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

// Precedence for the API KEY (highest first):
//   1. --project-api-key flag (`options.projectApiKey`)
//   2. LMNR_PROJECT_API_KEY env var
//   3. credentials file ~/.config/lmnr/credentials.json
//   4. throw (caller prints actionable message + exits)
//
// baseUrl resolves INDEPENDENTLY of which source won the key race (PLAN line
// 72): `--base-url` flag > LMNR_BASE_URL env > credentials file `baseUrl`. This
// means a user who passes only `--project-api-key X` against a local-dev creds
// file still hits the creds file's baseUrl (e.g. http://localhost:8020) rather
// than silently defaulting to api.lmnr.ai. The flag/env still win when set, so
// CI workflows that source a prod base URL are unaffected.
export const resolveAuth = async (
  options: AuthResolveOptions,
): Promise<ResolvedAuth> => {
  // Read once; used both for the key (branch 3) and for baseUrl fallback in all
  // branches. Best-effort: a malformed/unreadable file shouldn't block an
  // explicit flag/env key.
  const creds = await readCredentials().catch(() => null);
  const baseUrl = options.baseUrl ?? process.env.LMNR_BASE_URL ?? creds?.baseUrl;

  if (options.projectApiKey) {
    return { projectApiKey: options.projectApiKey, baseUrl, port: options.port };
  }

  if (process.env.LMNR_PROJECT_API_KEY) {
    return { projectApiKey: process.env.LMNR_PROJECT_API_KEY, baseUrl, port: options.port };
  }

  if (creds) {
    return { projectApiKey: creds.projectApiKey, baseUrl, port: options.port };
  }

  const err = new Error(
    "No Laminar credentials found. Run `lmnr-cli setup` (or `lmnr-cli login`)" +
      " or set LMNR_PROJECT_API_KEY.",
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
