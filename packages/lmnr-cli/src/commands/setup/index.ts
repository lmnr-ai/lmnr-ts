import { hostname } from "node:os";
import { relative } from "node:path";
import { createInterface } from "node:readline/promises";

import { type CliProject, LaminarClient } from "@lmnr-ai/client";

import { version } from "../../../package.json";
import { type Credentials, readCredentials } from "../../auth/credentials";
import { probeProjectKey } from "../../auth/project-id";
import { envHttpPort, refreshIfNeeded } from "../../auth/resolve";
import { orange, pc, pcOut } from "../../utils/colors";
import {
  findEnvKey,
  isPathGitIgnored,
  resolveEnvWriteTarget,
  writeEnvFile,
} from "../../utils/env-file";
import { installSkill } from "../../utils/install-skill";
import { type ProjectLink, readProjectLink, writeProjectLink } from "../../utils/project-link";
import { handleLogin } from "../login";

const DEFAULT_FRONTEND_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

// Exit codes (machine-readable contract — each distinct so automation can
// branch on the failure mode):
//   4  no_access            — user lacks access to the linked project
//   6  login_failed         — device-flow login failed / no creds after login
//   7  no_project           — no project to select (and none could be created)
//   8  env_write_failed     — minted a key but couldn't write ./.env
//   9  setup_key_failed     — POST /api/cli/api-key failed
//   10 list_projects_failed — GET /v1/cli/projects (discovery) failed
//   11 key_probe_failed     — couldn't verify the existing key (network/server error)
//   12 key_mismatch         — existing key belongs to a different project
const EXIT_NO_ACCESS = 4;
const EXIT_LOGIN_FAILED = 6;
const EXIT_NO_PROJECT = 7;
const EXIT_ENV_WRITE_FAILED = 8;
const EXIT_SETUP_KEY_FAILED = 9;
const EXIT_LIST_PROJECTS_FAILED = 10;
const EXIT_KEY_PROBE_FAILED = 11;
const EXIT_KEY_MISMATCH = 12;

export interface SetupOptions {
  writeEnv?: boolean;
  json?: boolean;
  noBrowser?: boolean;
  frontendUrl?: string;
  baseUrl?: string;
  /**
   * Explicit project id. Disambiguates when the user can access >1 project
   * (otherwise --json setup errors `project_ambiguous`). Validated against the
   * user's accessible projects before linking.
   */
  projectId?: string;
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
  /** The key written to .env, or null when an existing matching key was reused. */
  apiKey: string | null;
  envFileUpdated: string | null;
  /** SKILL.md paths written by the skill installer. */
  skillsInstalled: string[];
  frontendUrl: string;
  userEmail: string | null;
}

/**
 * Directory-scoped onboarding (SPEC decision tree):
 *  - log in if needed (browser picks/creates the project; its id rides back on
 *    the device-token metadata, see parseProjectFromMetadata),
 *  - resolve a project for this directory (`.lmnr/project.json`), enforcing
 *    access,
 *  - mint a project API key only when one isn't already configured for this
 *    project (checked across process.env → .env.local → .env), then write it to
 *    an existing .env.local or else .env,
 *  - install the Laminar skill into present agent dirs,
 *  - print a summary.
 *
 * The minted key goes ONLY into the project's env file, never into
 * credentials.json (which stores user-scoped BetterAuth tokens).
 */
export async function handleSetup(options: SetupOptions): Promise<void> {
  const writeEnv = options.writeEnv !== false;
  const frontendUrl = pick(
    options.frontendUrl,
    process.env.LMNR_FRONTEND_URL,
    DEFAULT_FRONTEND_URL,
  );
  const baseUrl = pick(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);
  const isJson = options.json === true;

  if (!isJson) {
    process.stderr.write(`\n${orange("Laminar CLI")} ${pc.dim(`v${version}`)}\n\n`);
  }

  const cwd = process.cwd();
  // Detect an already-configured key across process.env → .env.local → .env.
  const existingKey = await findEnvKey(cwd);

  let creds: Credentials | null = await safeReadCredentials();
  let link = await readProjectLink();

  // --- 1. Login + project resolution ---------------------------------------

  if (!creds) {
    // Not logged in: run the device flow. The browser is where the project is
    // chosen/created (when there's no link), and the chosen id rides back on
    // the device-token metadata (parseProjectFromMetadata).
    let login;
    try {
      login = await handleLogin({ frontendUrl, noBrowser: options.noBrowser });
    } catch (err) {
      emitError(isJson, "login_failed", describeError(err));
      process.exit(EXIT_LOGIN_FAILED);
    }
    creds = await safeReadCredentials();
    if (!creds) {
      emitError(isJson, "login_failed", "credentials missing after login");
      process.exit(EXIT_LOGIN_FAILED);
    }

    const issuer = creds.issuer || frontendUrl;
    const userBaseUrl = baseUrl;

    if (link) {
      // Directory already declares the project — ignore the metadata-borne id
      // and assert the freshly-authenticated user can access the linked project.
      await assertAccess(creds, userBaseUrl, link.projectId, isJson);
    } else if (login.projectId) {
      // Browser-selected (or just-created) project. Trust it and write the link.
      link = await writeLink(issuer, userBaseUrl, login.projectId, isJson);
    } else {
      // Defensive: fall back to the CLI picker if the browser didn't attach a
      // project via metadata.
      link = await resolveProjectViaCli(creds, userBaseUrl, issuer, isJson, options);
    }
  } else {
    // Already logged in.
    const userBaseUrl = baseUrl;
    const issuer = creds.issuer || frontendUrl;
    if (link) {
      await assertAccess(creds, userBaseUrl, link.projectId, isJson);
    } else {
      link = await resolveProjectViaCli(creds, userBaseUrl, issuer, isJson, options);
    }
  }

  if (!isJson) {
    process.stderr.write(`${pc.green("✓")} Logged in as ${creds.userEmail ?? "<unknown>"}\n`);
    process.stderr.write(
      `${pc.green("✓")} Project: ${link.projectName ?? link.projectId}` +
        (link.workspaceName ? pc.dim(` (${link.workspaceName})`) : "") +
        "\n",
    );
  }

  // --- 2. Assert invariants -------------------------------------------------

  if (!creds || !link.projectId) {
    emitError(isJson, "setup_invariant", "missing credentials or project after resolution");
    process.exit(EXIT_NO_PROJECT);
  }

  const issuer = creds.issuer || frontendUrl;
  const userBaseUrl = baseUrl;

  // --- 3. Key handling (SPEC 36-42) -----------------------------------------

  let apiKey: string | null = null;
  let envPath: string | null = null;
  let keyMeta: SetupKeyResponse | null = null;

  let needMint = true;
  if (existingKey) {
    const probe = await probeProjectKey(existingKey.value, userBaseUrl, envHttpPort());
    const where =
      existingKey.source.type === "process-env"
        ? "your environment"
        : relative(cwd, existingKey.source.path);

    if (probe.status === "unverifiable") {
      // Couldn't verify the key (network/server error). Do NOT mint — that would
      // clobber a possibly-valid key on a transient blip. Abort so the user retries.
      emitError(
        isJson,
        "key_probe_failed",
        `Couldn't verify the existing Project API Key in ${where} (network or server error). ` +
          "Check your connection and re-run.",
      );
      process.exit(EXIT_KEY_PROBE_FAILED);
    } else if (probe.status === "ok" && probe.projectId === link.projectId) {
      // Already configured for this project. Respect the user's setup: no mint,
      // no write (option a) — including when the key only lives in process.env.
      needMint = false;
      if (!isJson) {
        process.stderr.write(`${pc.green("✓")} Project API Key already set in ${where}\n`);
      }
    } else if (probe.status === "ok") {
      // Valid key, but for a DIFFERENT project. Refuse to clobber it — abort so the
      // user resolves the conflict deliberately rather than silently overwriting.
      emitError(
        isJson,
        "key_mismatch",
        `The Project API Key in ${where} belongs to a different project (${probe.projectId}), ` +
          `not the one linked here (${link.projectId}). Remove or update it, then re-run.`,
      );
      process.exit(EXIT_KEY_MISMATCH);
    } else if (!isJson) {
      // invalid / revoked (401) — minting a fresh key is the correct recovery.
      process.stderr.write(
        `${pc.yellow("⚠")} Existing Project API Key in ${where} is invalid or revoked, minting a new one\n`,
      );
    }
  }

  if (needMint) {
    try {
      keyMeta = await mintSetupKey(issuer, creds.sessionToken, link.projectId);
    } catch (err) {
      emitError(isJson, "setup_key_failed", describeError(err));
      process.exit(EXIT_SETUP_KEY_FAILED);
    }
    apiKey = keyMeta.apiKey;

    // Backfill display details onto the link if we learned them while minting.
    if (!link.projectName && keyMeta.projectName) link.projectName = keyMeta.projectName;
    if (!link.workspaceName && keyMeta.workspaceName) link.workspaceName = keyMeta.workspaceName;
    if (!link.workspaceId && keyMeta.workspaceId) link.workspaceId = keyMeta.workspaceId;

    if (writeEnv) {
      const target = await resolveEnvWriteTarget(cwd, existingKey);
      try {
        const result = await writeEnvFile(target, apiKey);
        envPath = result.path;
        if (!isJson) {
          const rel = relative(cwd, result.path);
          const verb = result.created
            ? "Created"
            : result.replaced
              ? "Updated LMNR_PROJECT_API_KEY in"
              : "Added LMNR_PROJECT_API_KEY to";
          process.stderr.write(`${pc.green("✓")} ${verb} ${rel}\n`);
          // The key is a secret; nudge if it landed in a tracked file.
          if ((await isPathGitIgnored(result.path)) === false) {
            process.stderr.write(
              `${pc.yellow("⚠")} ${rel} isn't gitignored; add it so the key isn't committed\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write(
          `\n${pc.red("ERROR")}: failed to write ${target}: ${describeError(err)}\n` +
            pc.dim("Your API key (set it manually):") +
            `\n  LMNR_PROJECT_API_KEY=${apiKey}\n\n`,
        );
        if (isJson) {
          process.stdout.write(
            JSON.stringify({
              error: "env_write_failed",
              apiKey,
              projectId: link.projectId,
              message: describeError(err),
            }) + "\n",
          );
        }
        process.exit(EXIT_ENV_WRITE_FAILED);
      }
    }
  }

  // --- 4. Skill install -----------------------------------------------------

  let skillsInstalled: string[] = [];
  try {
    // installSkill fetches the skill from the lmnr-skills repo and is
    // best-effort: it logs + returns `skipped: true` on network/codeload
    // failure rather than throwing, so setup never breaks here.
    const skillResult = await installSkill(process.cwd());
    skillsInstalled = skillResult.written;
    if (!isJson) {
      if (skillResult.skipped) {
        process.stderr.write(pc.dim("  Laminar skill install skipped\n"));
      } else if (skillResult.written.length > 0) {
        // One mark for the whole skill, not one per file (SKILL.md + references).
        const note = skillResult.defaulted
          ? pc.dim(" (no agent dir found; defaulted to .claude and .agents)")
          : "";
        process.stderr.write(`${pc.green("✓")} Installed Laminar skill${note}\n`);
      }
    }
  } catch (err) {
    if (!isJson) {
      process.stderr.write(
        `${pc.yellow("Warning")}: could not install Laminar skill (${describeError(err)}).\n`,
      );
    }
  }

  // --- 5. Summary -----------------------------------------------------------

  const frontendLink = `${trimSlash(issuer)}/project/${link.projectId}/traces`;

  const result: SetupResult = {
    projectId: link.projectId,
    projectName: link.projectName ?? null,
    workspaceId: link.workspaceId ?? null,
    workspaceName: link.workspaceName ?? null,
    apiKey,
    envFileUpdated: envPath,
    skillsInstalled,
    frontendUrl: frontendLink,
    userEmail: creds.userEmail ?? null,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    const docsUrl = "https://laminar.sh/docs/tracing/integrations/overview";
    const verifyCmd = 'lmnr-cli sql query "SELECT * FROM traces ORDER BY start_time DESC LIMIT 1" --json';
    process.stdout.write(
      "\nNext steps:\n" +
        "  1. Instrument your project with Laminar using the installed skill or the docs:\n" +
        `     ${pcOut.cyan(docsUrl)}\n` +
        "  2. Run your project.\n" +
        "  3. Verify instrumentation:\n" +
        `     ${pcOut.green(verifyCmd)}\n` +
        "  4. View your traces in the browser:\n" +
        `     ${pcOut.cyan(frontendLink)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Project resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a project via the CLI (logged-in, no link). 0 projects routes to the
 * browser create flow (gap A): we re-run the device flow, which lands on the
 * /device picker → first-project create UI, and the new project's id rides back
 * on the device-token metadata. >1 prompts a CLI choice; ==1 auto-selects.
 */
async function resolveProjectViaCli(
  creds: Credentials,
  userBaseUrl: string,
  issuer: string,
  isJson: boolean,
  options: SetupOptions,
): Promise<ProjectLink> {
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, userBaseUrl);
  } catch (err) {
    emitError(isJson, "list_projects_failed", describeError(err));
    process.exit(EXIT_LIST_PROJECTS_FAILED);
  }

  if (projects.length === 0) {
    // Gap A: no project to select and the CLI can't create one. Drive the
    // browser create flow — same path the not-logged-in 0-project user takes —
    // so project creation lives in ONE place (the /device picker).
    if (isJson) {
      emitError(
        isJson,
        "no_projects",
        `No projects found. Run \`lmnr-cli setup\` interactively (it opens the browser ` +
          `to create your first project) or create one at ${trimSlash(issuer)}/onboarding.`,
      );
      process.exit(EXIT_NO_PROJECT);
    }
    process.stderr.write(
      "\nYou have no projects yet. Opening the browser to create your first one...\n",
    );
    let login;
    try {
      login = await handleLogin({
        frontendUrl: issuer,
        noBrowser: options.noBrowser,
      });
    } catch (err) {
      emitError(isJson, "login_failed", describeError(err));
      process.exit(EXIT_LOGIN_FAILED);
    }
    if (!login.projectId) {
      emitError(
        isJson,
        "no_projects",
        `No project was created. Create one at ${trimSlash(issuer)}/onboarding then re-run setup.`,
      );
      process.exit(EXIT_NO_PROJECT);
    }
    return writeLink(issuer, userBaseUrl, login.projectId, isJson);
  }

  let chosen: CliProject;
  if (options.projectId) {
    // Explicit --project-id disambiguates. Validate against the accessible set.
    const match = projects.find((p) => p.id === options.projectId);
    if (!match) {
      emitError(
        isJson,
        "no_access",
        `You don't have access to project ${options.projectId}. Accessible: ` +
          projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
      );
      process.exit(EXIT_NO_ACCESS);
    }
    chosen = match;
  } else if (projects.length === 1) {
    chosen = projects[0];
  } else {
    if (isJson) {
      emitError(
        isJson,
        "project_ambiguous",
        `Multiple projects: pass --project-id <id>, or run setup interactively. ` +
          projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
      );
      process.exit(EXIT_NO_PROJECT);
    }
    chosen = await promptProjectChoice(projects);
  }

  const linkPath = await writeProjectLink({
    projectId: chosen.id,
    projectName: chosen.name,
    workspaceId: chosen.workspaceId,
    workspaceName: chosen.workspaceName,
  });
  if (!isJson) process.stderr.write(`${pc.green("✓")} Linked ${linkPath}\n`);
  return {
    projectId: chosen.id,
    projectName: chosen.name,
    workspaceId: chosen.workspaceId,
    workspaceName: chosen.workspaceName,
  };
}

/** Write `.lmnr/project.json`, enriching display details from listProjects when possible. */
async function writeLink(
  issuer: string,
  userBaseUrl: string,
  projectId: string,
  isJson: boolean,
): Promise<ProjectLink> {
  let link: ProjectLink = { projectId };
  try {
    const creds = await safeReadCredentials();
    if (creds) {
      const projects = await listProjects(creds, userBaseUrl);
      const match = projects.find((p) => p.id === projectId);
      if (match) {
        link = {
          projectId,
          projectName: match.name,
          workspaceId: match.workspaceId,
          workspaceName: match.workspaceName,
        };
      }
    }
  } catch {
    // Best-effort enrichment — the id is enough to proceed.
  }
  try {
    const linkPath = await writeProjectLink(link);
    if (!isJson) process.stderr.write(`${pc.green("✓")} Linked ${linkPath}\n`);
  } catch (err) {
    if (!isJson) {
      process.stderr.write(
        `${pc.yellow("Warning")}: could not write .lmnr/project.json (${describeError(err)}). ` +
          `CLI commands will need --project-id ${projectId}.\n`,
      );
    }
  }
  return link;
}

/**
 * Access check: the user must be a member of `projectId`. Calls
 * GET /v1/cli/projects (user JWT) and asserts the id is present; aborts
 * otherwise (SPEC: "You don't have access to the project in this directory").
 */
async function assertAccess(
  creds: Credentials,
  userBaseUrl: string,
  projectId: string,
  isJson: boolean,
): Promise<void> {
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, userBaseUrl);
  } catch (err) {
    emitError(isJson, "access_check_failed", describeError(err));
    process.exit(EXIT_NO_ACCESS);
  }
  if (!projects.some((p) => p.id === projectId)) {
    emitError(
      isJson,
      "no_access",
      "You don't have access to the project in this directory",
    );
    process.exit(EXIT_NO_ACCESS);
  }
}

/** List the projects the user can access (user-JWT-authed discovery). */
async function listProjects(creds: Credentials, baseUrl: string): Promise<CliProject[]> {
  const updated = await refreshIfNeeded(creds);
  // Discovery client: CliResource hits /v1/cli/projects with the bare bearer,
  // no project id needed (it overrides BaseResource's headers/prefix).
  const client = new LaminarClient({
    baseUrl,
    // setup has no --port flag, so honor LMNR_HTTP_PORT for local self-host
    // (baseUrl carries no port by convention). Cloud falls back to 443.
    port: envHttpPort(),
    auth: { type: "userToken", token: updated.accessToken, projectId: "" },
  });
  return client.cli.listProjects();
}

async function safeReadCredentials(): Promise<Credentials | null> {
  try {
    return await readCredentials();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Key minting
// ---------------------------------------------------------------------------

/** POST /api/cli/api-key with the session bearer for an explicit project. */
async function mintSetupKey(
  issuer: string,
  sessionToken: string,
  projectId: string,
): Promise<SetupKeyResponse> {
  const url = `${trimSlash(issuer)}/api/cli/api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceName: hostname(), projectId }),
  });
  if (res.ok) {
    return (await res.json()) as SetupKeyResponse;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `api-key request failed (${res.status})`);
}

async function promptProjectChoice(projects: CliProject[]): Promise<CliProject> {
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
      process.stderr.write(`${pc.red("Invalid selection.")}\n`);
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
    process.stderr.write(`\n${pc.red(`ERROR (${code})`)}: ${detail}\n`);
  }
}
