import { relative } from "node:path";

import { type CliProject } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { version } from "../../../package.json";
import { type Credentials, safeReadCredentials } from "../../auth/credentials";
import { refreshIfNeeded, SessionExpiredError } from "../../auth/resolve";
import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../../constants";
import { orange, pc, pcOut } from "../../utils/colors";
import { type EnvKeyLocation, findEnvKey } from "../../utils/env-file";
import { installSkill } from "../../utils/install-skill";
import {
  type LocalProjectFile,
  readLocalProjectFile,
  writeLocalProjectFile,
} from "../../utils/local-project-file";
import { emitError } from "../../utils/output";
import { listProjects, promptProjectChoice } from "../../utils/projects";
import { firstNonEmpty, trimSlash } from "../../utils/text";
import { handleLogin } from "../login";
import {
  ensureProjectKey,
  EXIT_LIST_PROJECTS_FAILED,
  EXIT_LOGIN_FAILED,
  EXIT_NO_ACCESS,
  EXIT_NO_PROJECT,
} from "../project/link-core";

export interface SetupOptions {
  writeEnv?: boolean;
  json?: boolean;
  /** Set by commander's `--no-browser`; false suppresses the device-flow open. */
  browser?: boolean;
  frontendUrl?: string;
  baseUrl?: string;
  /**
   * Explicit project id. Disambiguates when the user can access >1 project
   * (otherwise --json setup errors `project_ambiguous`). Validated against the
   * user's accessible projects before linking.
   */
  projectId?: string;
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
  const frontendUrl = firstNonEmpty(
    options.frontendUrl,
    process.env.LMNR_FRONTEND_URL,
    DEFAULT_FRONTEND_URL,
  );
  const baseUrl = firstNonEmpty(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);
  const isJson = options.json === true;

  if (!isJson) {
    process.stderr.write(`\n${orange("Laminar CLI")} ${pc.dim(`v${version}`)}\n\n`);
  }

  const cwd = process.cwd();
  // Detect an already-configured key across process.env → .env.local → .env.
  const existingKey = await findEnvKey(cwd);

  let creds: Credentials | null = await safeReadCredentials();
  let link = await readLocalProjectFile();

  // Expiry gate: an expired session still leaves a valid-shaped credentials.json
  // on disk, so without this setup would take the "already logged in" branch and
  // then dead-end on the first authed call (list_projects → list_projects_failed).
  // Validate the session now; an expired grant is ABSORBED — we drop the creds so
  // the not-logged-in branch below re-runs the device flow (honoring --no-browser)
  // and onboarding continues. A non-expiry error (network/5xx / server blip) is
  // deliberately left for the downstream authed call to surface through its coded
  // path (list_projects_failed, exit 10) so a transient failure is never
  // conflated with an expiry.
  if (creds) {
    try {
      creds = await refreshIfNeeded(creds);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        creds = null;
      }
    }
  }

  // --- 1. Login + project resolution ---------------------------------------

  if (!creds) {
    // Not logged in: run the device flow. The browser is where the project is
    // chosen/created (when there's no link), and the chosen id rides back on
    // the device-token metadata (parseProjectFromMetadata).
    let login;
    try {
      login = await handleLogin({ frontendUrl, noBrowser: options.browser === false });
    } catch (err) {
      emitError(isJson, "login_failed", errorMessage(err));
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
      await assertAccess(creds, userBaseUrl, link, existingKey, isJson);
    } else if (login.projectId) {
      // Browser-selected (or just-created) project. Trust it and write the link.
      link = await writeLink(userBaseUrl, login.projectId, isJson);
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
      await assertAccess(creds, userBaseUrl, link, existingKey, isJson);
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
  // Shared with `project link` — the whole probe/mint/write is `ensureProjectKey`.
  const { apiKey, envFileUpdated: envPath } = await ensureProjectKey({
    creds,
    link,
    existingKey,
    cwd,
    issuer,
    userBaseUrl,
    writeEnv,
    isJson,
  });

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
        `${pc.yellow("Warning")}: could not install Laminar skill (${errorMessage(err)}).\n`,
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
    const verifyCmd =
      'lmnr-cli sql query "SELECT * FROM traces ORDER BY start_time DESC LIMIT 1" --json';
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
): Promise<LocalProjectFile> {
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, userBaseUrl);
  } catch (err) {
    emitError(isJson, "list_projects_failed", errorMessage(err));
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
        noBrowser: options.browser === false,
      });
    } catch (err) {
      emitError(isJson, "login_failed", errorMessage(err));
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
    return writeLink(userBaseUrl, login.projectId, isJson);
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
    chosen = await promptProjectChoice(projects, "\nMultiple projects available. Choose one:\n");
  }

  const linkPath = await writeLocalProjectFile({
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
  userBaseUrl: string,
  projectId: string,
  isJson: boolean,
): Promise<LocalProjectFile> {
  let link: LocalProjectFile = { projectId };
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
    const linkPath = await writeLocalProjectFile(link);
    if (!isJson) process.stderr.write(`${pc.green("✓")} Linked ${linkPath}\n`);
  } catch (err) {
    if (!isJson) {
      process.stderr.write(
        `${pc.yellow("Warning")}: could not write .lmnr/project.json (${errorMessage(err)}). ` +
        `CLI commands will need --project-id ${projectId}.\n`,
      );
    }
  }
  return link;
}

/**
 * Access check: the logged-in user must be a member of the directory-linked
 * project (`link.projectId`). Calls GET /v1/cli/projects (user JWT) and asserts
 * the id is present; aborts otherwise (SPEC: "You don't have access to the
 * project in this directory"). On failure, names the actual mismatch (linked
 * project vs. logged-in account) and the two things that pin a stale project —
 * `.lmnr/project.json` and any `LMNR_PROJECT_API_KEY` in the environment.
 */
async function assertAccess(
  creds: Credentials,
  userBaseUrl: string,
  link: LocalProjectFile,
  existingKey: EnvKeyLocation | null,
  isJson: boolean,
): Promise<void> {
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, userBaseUrl);
  } catch (err) {
    // Discovery FAILED (network/5xx) — we couldn't determine access. Report it
    // as a transient list failure (exit 10), NOT no_access (exit 4): automation
    // must be able to retry instead of concluding the user lacks access.
    emitError(isJson, "list_projects_failed", errorMessage(err));
    process.exit(EXIT_LIST_PROJECTS_FAILED);
  }
  if (!projects.some((p) => p.id === link.projectId)) {
    emitError(isJson, "no_access", buildNoAccessDetail(link, creds, existingKey, projects));
    process.exit(EXIT_NO_ACCESS);
  }
}

/**
 * Build the `no_access` detail: lead with the SPEC sentence (so substring
 * matchers keep working), then explain the linked-project-vs-account mismatch
 * and the concrete remediation steps.
 */
function buildNoAccessDetail(
  link: LocalProjectFile,
  creds: Credentials,
  existingKey: EnvKeyLocation | null,
  accessible: CliProject[],
): string {
  const project = link.projectName ? `"${link.projectName}" (${link.projectId})` : link.projectId;
  const account = creds.userEmail ?? "the current account";
  const workspace = link.workspaceName ? ` in workspace "${link.workspaceName}"` : "";
  const keyWhere =
    existingKey === null
      ? null
      : existingKey.source.type === "process-env"
        ? { loc: "your environment", verb: "unset it" }
        : { loc: relative(process.cwd(), existingKey.source.path), verb: "remove that line" };
  const envHint = keyWhere
    ? `\n  • A stale LMNR_PROJECT_API_KEY in ${keyWhere.loc} can pin a different project — ` +
      `${keyWhere.verb}, then re-run setup.`
    : "";
  const accessLine =
    accessible.length > 0
      ? `You're logged in as ${account}, which has access to ${accessible.length} ` +
        `project(s), but not this one.`
      : `You're logged in as ${account}, which has access to no projects.`;

  return (
    `You don't have access to the project in this directory. ` +
    `It's linked (.lmnr/project.json) to project ${project}${workspace}. ${accessLine}\n\n` +
    `To fix, pick one:\n` +
    `  • Wrong account? Run \`lmnr-cli login\` as someone with access, then re-run setup.\n` +
    `  • Want a different project here? Re-point this directory: ` +
    `\`lmnr-cli project link\`.${envHint}`
  );
}
