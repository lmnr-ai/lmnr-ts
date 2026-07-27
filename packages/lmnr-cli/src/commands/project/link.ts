import { type CliProject } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { safeReadCredentials } from "../../auth/credentials";
import { SessionExpiredError } from "../../auth/resolve";
import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../../constants";
import {
  failWith,
  listProjectsFailed,
  loginFailed,
  noAccess,
  noProject,
  projectAmbiguous,
} from "../../errors";
import { pc } from "../../utils/colors";
import { findEnvKey } from "../../utils/env-file";
import { type LocalProjectFile, writeLocalProjectFile } from "../../utils/local-project-file";
import { listProjects, promptProjectChoice } from "../../utils/projects";
import { firstNonEmpty, trimSlash } from "../../utils/text";
import { ensureProjectKey } from "./link-core";

export interface ProjectLinkOptions {
  /** Explicit target project id — skips the interactive picker. */
  projectId?: string;
  baseUrl?: string;
  json?: boolean;
  /** Set by commander's `--no-write-env`; false suppresses the ./.env write. */
  writeEnv?: boolean;
}

export interface ProjectLinkResult {
  projectId: string;
  projectName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  /** The key written to .env, or null when an existing matching key was reused. */
  apiKey: string | null;
  envFileUpdated: string | null;
  linkPath: string;
  /**
   * Set when the existing LMNR_PROJECT_API_KEY belongs to a DIFFERENT project:
   * that project's id. The re-link still succeeds; mint a key for the new project
   * with `lmnr-cli project mint-key` and replace the stale one. Null when the key
   * matched (or none was present).
   */
  keyMismatchProjectId: string | null;
}

/**
 * `lmnr-cli project link` — (re)bind the current directory to a project by
 * rewriting `.lmnr/project.json`, then ensure a usable Project API Key for the
 * NEW project (the same probe/mint/write `setup` runs, via `ensureProjectKey`).
 *
 * With no `--project-id` it opens the (already alphabetically-sorted) picker;
 * `--project-id <id>` sets it directly, validated against the user's accessible
 * projects. Requires an existing login (no device flow here) — manages its own
 * exit codes / `--json` contract like `setup`, so it is registered with a bare
 * `.action(...)` rather than a with-client wrapper.
 */
export async function handleProjectLink(options: ProjectLinkOptions): Promise<void> {
  const isJson = options.json === true;
  const writeEnv = options.writeEnv !== false;
  const baseUrl = firstNonEmpty(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);

  const creds = await safeReadCredentials();
  if (!creds) {
    failWith(isJson, loginFailed("Not authenticated. Run `lmnr-cli login` first."));
  }
  const issuer = creds.issuer || DEFAULT_FRONTEND_URL;

  // Discovery (user JWT). Sorted at the client choke point, so the picker below
  // is already alphabetical.
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, baseUrl);
  } catch (err) {
    // An expired grant surfaces here via listProjects → refreshIfNeeded. Keep it
    // distinct from a discovery failure: it's an auth problem (exit 6), not a
    // list_projects_failed (exit 10) — same distinction setup makes.
    if (err instanceof SessionExpiredError) {
      failWith(isJson, loginFailed("Session expired. Run `lmnr-cli login` first."));
    }
    failWith(isJson, listProjectsFailed(errorMessage(err)));
  }

  if (projects.length === 0) {
    failWith(
      isJson,
      noProject(
        `No projects to link. Create one at ${trimSlash(issuer)}/onboarding, then re-run.`,
      ),
    );
  }

  // Choose the target project (mirrors setup's resolution semantics).
  let chosen: CliProject;
  if (options.projectId) {
    const match = projects.find((p) => p.id === options.projectId);
    if (!match) {
      failWith(
        isJson,
        noAccess(
          `You don't have access to project ${options.projectId}. Accessible: ` +
          projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
        ),
      );
    }
    chosen = match;
  } else if (projects.length === 1) {
    chosen = projects[0];
  } else if (isJson) {
    // No id and >1 project: can't prompt in --json mode.
    failWith(
      isJson,
      projectAmbiguous(
        `Multiple projects: pass --project-id <id>. ` +
        projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
      ),
    );
  } else {
    chosen = await promptProjectChoice(
      projects,
      "\nSelect a project to link to this directory:\n",
    );
  }

  // Rewrite .lmnr/project.json to the chosen project.
  const link: LocalProjectFile = {
    projectId: chosen.id,
    projectName: chosen.name,
    workspaceId: chosen.workspaceId,
    workspaceName: chosen.workspaceName,
  };

  // Ensure a key for the NEW project FIRST — shared verbatim with `setup`. It
  // can hard-exit (key mismatch / unverifiable / mint or env-write failure), so
  // we commit the re-link to disk only AFTER it succeeds: a failed
  // `project link` must not leave the directory silently re-pointed. (On mint,
  // ensureProjectKey also backfills display details onto `link`, so writing
  // afterwards captures them.)
  const cwd = process.cwd();
  const existingKey = await findEnvKey(cwd);
  const { apiKey, envFileUpdated, mismatchProjectId } = await ensureProjectKey({
    creds,
    link,
    existingKey,
    cwd,
    issuer,
    userBaseUrl: baseUrl,
    writeEnv,
    // Re-pointing is intentional: a key for a different project warns (and points
    // at `project mint-key`) instead of hard-failing, so the re-link still goes through.
    onKeyMismatch: "warn",
    isJson,
  });

  const linkPath = await writeLocalProjectFile(link);
  if (!isJson) process.stderr.write(`${pc.green("✓")} Linked ${linkPath}\n`);

  const result: ProjectLinkResult = {
    projectId: link.projectId,
    projectName: link.projectName ?? null,
    workspaceId: link.workspaceId ?? null,
    workspaceName: link.workspaceName ?? null,
    apiKey,
    envFileUpdated,
    linkPath,
    keyMismatchProjectId: mismatchProjectId,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // Human confirmation is a message, not data — stderr (matches the ✓ lines above).
  process.stderr.write(
    `\n${pc.green("✓")} This directory is now linked to ` +
    `${link.projectName ?? link.projectId}` +
    (link.workspaceName ? pc.dim(` (${link.workspaceName})`) : "") +
    "\n",
  );
}
