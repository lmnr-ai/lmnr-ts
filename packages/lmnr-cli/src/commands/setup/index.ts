import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
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

interface AmbiguousProject {
  id: string;
  name: string;
  workspaceName: string;
}

interface SetupKeyResponse {
  apiKey: string;
  apiKeyId: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
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
 * One-shot onboarding: login (if needed) → mint a project API key via
 * POST /api/cli/setup-key (session bearer) → write LMNR_PROJECT_API_KEY to
 * ./.env. The minted key goes ONLY to ./.env, never into credentials.json
 * (which stores user-scoped BetterAuth tokens).
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
  }

  const issuer = profile.issuer || dashboardUrl;

  // Mint a project API key. The server resolves the project from the user's
  // memberships; on ambiguity we prompt for a choice and re-POST.
  let keyResult: SetupKeyResponse;
  try {
    keyResult = await mintSetupKey(issuer, profile.sessionToken, isJson);
  } catch (err) {
    if (err instanceof NoProjectsError) {
      emitError(
        isJson,
        "no_projects",
        `No projects found. Create one at ${trimSlash(issuer)}/onboarding then re-run \`lmnr-cli setup\`.`,
      );
      process.exit(7);
    }
    emitError(isJson, "setup_key_failed", describeError(err));
    process.exit(7);
  }

  if (!isJson) {
    process.stderr.write(
      `✓ Project: ${keyResult.projectName} (${keyResult.workspaceName})\n`,
    );
  }

  const apiKey = keyResult.apiKey;

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
          projectId: keyResult.projectId,
          message: describeError(err),
        };
        process.stdout.write(JSON.stringify(payload) + "\n");
      }
      process.exit(8);
    }
  }

  const dashboardLink = `${trimSlash(issuer)}/project/${keyResult.projectId}/traces`;
  const revokeLink = `${trimSlash(issuer)}/project/${keyResult.projectId}/settings/api-keys`;

  const result: SetupResult = {
    projectId: keyResult.projectId,
    projectName: keyResult.projectName,
    workspaceId: keyResult.workspaceId,
    workspaceName: keyResult.workspaceName,
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

class NoProjectsError extends Error {}

/**
 * POST /api/cli/setup-key with the session bearer. On `project_ambiguous`,
 * prompt the user to pick from the returned list (non-JSON only) and re-POST
 * with the chosen projectId.
 */
async function mintSetupKey(
  issuer: string,
  sessionToken: string,
  isJson: boolean,
  projectId?: string,
): Promise<SetupKeyResponse> {
  const url = `${trimSlash(issuer)}/api/cli/setup-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceName: hostname(), ...(projectId ? { projectId } : {}) }),
  });

  if (res.ok) {
    return (await res.json()) as SetupKeyResponse;
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    projects?: AmbiguousProject[];
  };

  if (body.error === "no_projects") {
    throw new NoProjectsError("no projects");
  }
  if (body.error === "project_ambiguous" && body.projects && body.projects.length > 0) {
    if (isJson) {
      // No way to prompt in machine mode — surface the list for the caller.
      throw new Error(
        `project_ambiguous: pass --project or LMNR_PROJECT_ID. Projects: ` +
          body.projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
      );
    }
    const chosen = await promptProjectChoice(body.projects);
    return mintSetupKey(issuer, sessionToken, isJson, chosen.id);
  }

  throw new Error(body.error ?? `setup-key request failed (${res.status})`);
}

async function promptProjectChoice(projects: AmbiguousProject[]): Promise<AmbiguousProject> {
  process.stderr.write("\nMultiple projects available. Choose one:\n");
  projects.forEach((p, i) => {
    process.stderr.write(`  ${i + 1}) ${p.workspaceName} / ${p.name}\n`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (await rl.question(`Select [1-${projects.length}]: `)).trim();
      const idx = Number.parseInt(answer, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) {
        return projects[idx - 1];
      }
      process.stderr.write("Invalid selection.\n");
    }
  } finally {
    rl.close();
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
