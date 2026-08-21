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
import {
  type LocalProjectFile,
  writeLocalProjectFile,
} from "../../utils/local-project-file";
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
   * Id of the different project the existing key belongs to; null if it matched
   * (or none present). The re-link still succeeds — replace the stale key via
   * `lmnr-cli project mint-key`.
   */
  keyMismatchProjectId: string | null;
}

/**
 * `lmnr-cli project link` — (re)bind the current directory to a project by
 * rewriting `.lmnr/project.json`, then ensure a Project API Key for it via
 * `ensureProjectKey` (same as `setup`). No `--project-id` opens the picker;
 * `--project-id <id>` is validated against accessible projects. Requires login.
 */
export async function handleProjectLink(
  options: ProjectLinkOptions,
): Promise<void> {
  const isJson = options.json === true;
  const writeEnv = options.writeEnv !== false;
  const baseUrl = firstNonEmpty(
    options.baseUrl,
    process.env.LMNR_BASE_URL,
    DEFAULT_BASE_URL,
  );

  const creds = await safeReadCredentials();
  if (!creds) {
    failWith(
      isJson,
      loginFailed("Not authenticated. Run `lmnr-cli login` first."),
    );
  }
  const issuer = creds.issuer || DEFAULT_FRONTEND_URL;

  // Sorted at the client choke point, so the picker is already alphabetical.
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, baseUrl);
  } catch (err) {
    // Expired grant is an auth problem (exit 6), not a discovery failure (exit 10).
    if (err instanceof SessionExpiredError) {
      failWith(
        isJson,
        loginFailed("Session expired. Run `lmnr-cli login` first."),
      );
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
            projects
              .map((p) => `${p.id} (${p.workspaceName}/${p.name})`)
              .join(", "),
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
          projects
            .map((p) => `${p.id} (${p.workspaceName}/${p.name})`)
            .join(", "),
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

  // Ensure the key BEFORE writing the link: it can hard-exit, and a failed
  // `project link` must not leave the directory silently re-pointed. It also
  // backfills display details onto `link`, so writing afterwards captures them.
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
    // Warn (don't fail) on a mismatched key so the intentional re-link goes through.
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
