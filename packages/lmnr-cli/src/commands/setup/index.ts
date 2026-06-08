import { resolve as resolvePath } from "node:path";

import {
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
} from "../../auth/credentials";
import { readEnvVar, writeEnvFile } from "../../utils/env-file";
import { handleLogin } from "../login";

const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

export interface SetupOptions {
  writeEnv?: boolean;
  json?: boolean;
  noBrowser?: boolean;
  dashboardUrl?: string;
  baseUrl?: string;
}

export interface SetupResult {
  projectId: string;
  projectName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  apiKey: string;
  envFileUpdated: string | null;
  dashboardUrl: string;
  userEmail: string | null;
}

/**
 * One-shot onboarding: login (if needed) → write LMNR_PROJECT_API_KEY to
 * ./.env from the active profile. Workspace + project bootstrap now happens
 * in the browser approval flow (see frontend /device page), so the CLI no
 * longer round-trips through /api/cli/setup / /api/cli/projects/<id>/api-keys.
 */
export async function handleSetup(options: SetupOptions): Promise<void> {
  const writeEnv = options.writeEnv !== false;
  const dashboardUrl = pick(
    options.dashboardUrl,
    process.env.LMNR_DASHBOARD_URL,
    DEFAULT_DASHBOARD_URL,
  );
  const baseUrl = pick(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);
  const isJson = options.json === true;

  // Short-circuit if the cwd already has Laminar configured.
  const cwdEnvPath = resolvePath(process.cwd(), ".env");
  const existingKey = await readEnvVar(cwdEnvPath, "LMNR_PROJECT_API_KEY");
  if (existingKey) {
    if (isJson) {
      process.stdout.write(
        JSON.stringify({ skipped: true, reason: "already_configured", envFile: cwdEnvPath }) + "\n",
      );
    } else {
      process.stderr.write(
        `Laminar is already configured: LMNR_PROJECT_API_KEY is set in ${cwdEnvPath}. Skipping setup.\n`,
      );
    }
    process.exit(0);
  }

  // Login if needed.
  let creds: StoredCredentials | null = null;
  let profile: ProfileEntry | null = null;
  try {
    creds = await readCredentials();
    profile = creds ? getActiveProfile(creds) : null;
  } catch {
    creds = null;
    profile = null;
  }
  if (!profile) {
    try {
      await handleLogin({
        dashboardUrl,
        baseUrl,
        noBrowser: options.noBrowser,
      });
    } catch (err) {
      emitError(isJson, "login_failed", describeError(err));
      process.exit(6);
    }
    creds = await readCredentials();
    profile = creds ? getActiveProfile(creds) : null;
    if (!creds || !profile) {
      emitError(isJson, "login_failed", "credentials missing after login");
      process.exit(6);
    }
  }

  if (!isJson) {
    process.stderr.write(`✓ Logged in as ${profile.userEmail ?? "<unknown>"}\n`);
    process.stderr.write(
      `✓ Project: ${profile.projectName ?? profile.projectId} (${profile.workspaceName ?? "workspace"})\n`,
    );
  }

  const issuer = profile.issuer || dashboardUrl;
  const apiKey = profile.accessToken;

  // Write .env.
  let envPath: string | null = null;
  if (writeEnv) {
    const target = resolvePath(process.cwd(), ".env");
    try {
      const result = await writeEnvFile(target, apiKey);
      envPath = result.path;
      if (!isJson) {
        const verb = result.created
          ? "Created"
          : result.replaced
            ? "Replaced LMNR_PROJECT_API_KEY in"
            : "Appended LMNR_PROJECT_API_KEY to";
        process.stderr.write(`✓ ${verb} ${result.path}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `\nERROR: failed to write ${target}: ${describeError(err)}\n` +
          `Your API key (set it manually):\n  LMNR_PROJECT_API_KEY=${apiKey}\n\n`,
      );
      if (isJson) {
        const payload = {
          error: "env_write_failed",
          apiKey,
          projectId: profile.projectId,
          message: describeError(err),
        };
        process.stdout.write(JSON.stringify(payload) + "\n");
      }
      process.exit(8);
    }
  }

  const dashboardLink = `${trimSlash(issuer)}/project/${profile.projectId}/traces`;
  const revokeLink = `${trimSlash(issuer)}/project/${profile.projectId}/settings/api-keys`;

  const result: SetupResult = {
    projectId: profile.projectId,
    projectName: profile.projectName ?? null,
    workspaceId: profile.workspaceId ?? null,
    workspaceName: profile.workspaceName ?? null,
    apiKey,
    envFileUpdated: envPath,
    dashboardUrl: dashboardLink,
    userEmail: profile.userEmail ?? null,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(
      `\nDashboard:    ${dashboardLink}\n` + `Revoke key:   ${revokeLink}\n`,
    );
  }
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function emitError(json: boolean, code: string, detail: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: code, detail }) + "\n");
  } else {
    process.stderr.write(`\nERROR (${code}): ${detail}\n`);
  }
}
