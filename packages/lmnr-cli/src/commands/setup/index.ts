import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

import { readCredentials, type StoredCredentials, writeCredentials } from "../../auth/credentials";
import { refreshIfNeeded } from "../../auth/resolve";
import { writeEnvFile } from "../../utils/env-file";
import { deriveProjectName, deriveWorkspaceName } from "../../utils/project-name";
import { handleLogin } from "../login";

const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

export interface SetupOptions {
  workspace?: string;
  projectName?: string;
  writeEnv?: boolean;
  json?: boolean;
  noBrowser?: boolean;
  dashboardUrl?: string;
  baseUrl?: string;
}

export interface SetupResult {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCreated: boolean;
  projectCreated: boolean;
  apiKey: string;
  apiKeyName: string;
  envFileUpdated: string | null;
  dashboardUrl: string;
  userEmail: string | null;
}

interface CallerContext {
  bearer: string;
  issuer: string;
  baseUrl: string;
  userEmail: string | null;
}

/**
 * One-shot onboarding: login (if needed) → bootstrap workspace + project →
 * mint API key → write `.env` → print summary. Exits with non-zero on
 * recoverable failures so coding agents can branch on $?.
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

  // Step 1 — login if needed.
  let creds: StoredCredentials | null;
  try {
    creds = await readCredentials();
    if (creds) {
      creds = await refreshIfNeeded(creds);
    }
  } catch (err) {
    if (!isJson) {
      process.stderr.write(`Refresh failed (${describeError(err)}); re-running login...\n`);
    }
    creds = null;
  }
  if (!creds) {
    try {
      await handleLogin({
        dashboardUrl,
        baseUrl,
        noBrowser: options.noBrowser,
        projectId: undefined,
      });
    } catch (err) {
      emitError(isJson, "login_failed", describeError(err));
      process.exit(6);
    }
    creds = await readCredentials();
    if (!creds) {
      emitError(isJson, "login_failed", "credentials missing after login");
      process.exit(6);
    }
  }

  const caller: CallerContext = {
    bearer: creds.accessToken,
    issuer: creds.issuer || dashboardUrl,
    baseUrl: creds.baseUrl || baseUrl,
    userEmail: creds.userEmail ?? null,
  };

  if (!isJson) {
    process.stderr.write(`✓ Logged in as ${caller.userEmail ?? "<unknown>"}\n`);
  }

  // Step 2/3 — derive names.
  const projectName = deriveProjectName({ explicit: options.projectName });
  const workspaceName = deriveWorkspaceName();

  // Step 4 — bootstrap.
  let bootstrap = await postBootstrap(caller, {
    workspaceId: options.workspace,
    workspaceName,
    projectName,
  });

  if (
    bootstrap.status === 400 &&
    bootstrap.body?.error === "workspace_ambiguous" &&
    !options.workspace
  ) {
    const candidates = (bootstrap.body.workspaces ?? []) as { id: string; name: string }[];
    if (isJson || !process.stdin.isTTY) {
      process.stdout.write(
        JSON.stringify({
          error: "workspace_ambiguous",
          workspaces: candidates,
        }) + "\n",
      );
      process.exit(7);
    }
    const chosenId = await pickWorkspace(candidates);
    if (!chosenId) {
      emitError(false, "workspace_pick_aborted", "Selection aborted.");
      process.exit(7);
    }
    bootstrap = await postBootstrap(caller, {
      workspaceId: chosenId,
      workspaceName,
      projectName,
    });
  }

  if (bootstrap.status !== 200 || !bootstrap.body) {
    emitError(isJson, bootstrap.body?.error ?? "bootstrap_failed", JSON.stringify(bootstrap.body));
    process.exit(1);
  }

  const {
    workspaceId,
    workspaceName: resolvedWorkspaceName,
    workspaceCreated,
    projectId,
    projectName: resolvedProjectName,
    projectCreated,
  } = bootstrap.body as {
    workspaceId: string;
    workspaceName: string;
    workspaceCreated: boolean;
    projectId: string;
    projectName: string;
    projectCreated: boolean;
  };

  if (!isJson) {
    process.stderr.write(
      `✓ Workspace: ${resolvedWorkspaceName} (${workspaceCreated ? "created" : "existing"})\n`,
    );
    process.stderr.write(
      `✓ Project: ${resolvedProjectName} (${projectCreated ? "created" : "existing"})\n`,
    );
  }

  // Step 5 — mint API key.
  const apiKeyName = `cli-setup-${resolvedProjectName}-${utcDate()}`;
  const mint = await postApiKey(caller, projectId, apiKeyName);
  if (mint.status !== 200 || !mint.body) {
    emitError(isJson, mint.body?.error ?? "api_key_failed", JSON.stringify(mint.body));
    process.exit(1);
  }
  const apiKey = (mint.body as { value: string }).value;
  if (!isJson) {
    process.stderr.write(`✓ API key: ${apiKeyName}\n`);
  }

  // Persist project id in credentials so subsequent `traces wait` etc. work.
  await writeCredentials({
    ...creds,
    projectId,
    projectName: resolvedProjectName,
    workspaceId,
    workspaceName: resolvedWorkspaceName,
  });

  // Step 6 — write .env.
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
      // Surface key on stderr so the agent can rescue it.
      process.stderr.write(
        `\nERROR: failed to write ${target}: ${describeError(err)}\n` +
          `Your API key (set it manually):\n  LMNR_PROJECT_API_KEY=${apiKey}\n\n`,
      );
      if (isJson) {
        const payload = {
          error: "env_write_failed",
          apiKey,
          projectId,
          message: describeError(err),
        };
        process.stdout.write(JSON.stringify(payload) + "\n");
      }
      process.exit(8);
    }
  }

  // Step 7 — summary.
  const dashboardLink = `${caller.issuer.replace(/\/+$/, "")}/project/${projectId}/traces`;
  const revokeLink = `${caller.issuer.replace(/\/+$/, "")}/project/${projectId}/settings/api-keys`;

  const result: SetupResult = {
    projectId,
    projectName: resolvedProjectName,
    workspaceId,
    workspaceName: resolvedWorkspaceName,
    workspaceCreated,
    projectCreated,
    apiKey,
    apiKeyName,
    envFileUpdated: envPath,
    dashboardUrl: dashboardLink,
    userEmail: caller.userEmail,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(
      `\nDashboard:    ${dashboardLink}\n` +
        `Revoke key:   ${revokeLink}\n`,
    );
  }
}

async function postBootstrap(
  caller: CallerContext,
  body: { workspaceId?: string; workspaceName: string; projectName: string },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return jsonFetch(caller, "POST", "/api/cli/bootstrap", body);
}

async function postApiKey(
  caller: CallerContext,
  projectId: string,
  name: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return jsonFetch(caller, "POST", `/api/cli/projects/${projectId}/api-keys`, {
    name,
    isIngestOnly: false,
  });
}

async function jsonFetch(
  caller: CallerContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const url = `${caller.issuer.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${caller.bearer}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: Record<string, unknown> | null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function pickWorkspace(candidates: { id: string; name: string }[]): Promise<string | null> {
  if (candidates.length === 0) return null;
  process.stderr.write("\nMultiple workspaces. Pick one:\n");
  candidates.forEach((w, i) => {
    process.stderr.write(`  ${i + 1}. ${w.name} (${w.id})\n`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveP) => {
      rl.question(`Enter 1-${candidates.length}: `, (a) => resolveP(a));
    });
    const idx = Number(answer.trim());
    if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) {
      return null;
    }
    return candidates[idx - 1].id;
  } finally {
    rl.close();
  }
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
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
