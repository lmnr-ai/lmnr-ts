import { readCredentials } from "../commands/auth/credentials";

export interface ResolvedAuth {
  projectApiKey: string;
  baseUrl?: string;
  port?: number;
}

export interface AuthResolveOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
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
