import { hostname } from "node:os";

import { errorMessage } from "@lmnr-ai/types";

import { mintProjectApiKey } from "../../auth/api-key";
import { safeReadCredentials } from "../../auth/credentials";
import { refreshIfNeeded, SessionExpiredError } from "../../auth/resolve";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { failWith, loginFailed, noProject, setupKeyFailed } from "../../errors";
import { pc } from "../../utils/colors";
import { readLocalProjectFile } from "../../utils/local-project-file";

export interface ProjectMintKeyOptions {
  /** Project to mint for. Defaults to the linked `.lmnr/project.json`. */
  projectId?: string;
  json?: boolean;
}

export interface ProjectMintKeyResult {
  projectId: string;
  apiKey: string;
  apiKeyId: string | null;
}

/**
 * `lmnr-cli project mint-key` — mint a fresh Project API Key for the linked
 * project (or `--project-id`) and PRINT it. Unlike `setup` / `project link`, it
 * deliberately does NOT write `.env` — the bare key goes to stdout (pipe-friendly),
 * everything else to stderr. Requires an existing login.
 */
export async function handleProjectMintKey(
  options: ProjectMintKeyOptions,
): Promise<void> {
  const isJson = options.json === true;

  const creds = await safeReadCredentials();
  if (!creds) {
    failWith(
      isJson,
      loginFailed("Not authenticated. Run `lmnr-cli login` first."),
    );
  }

  const projectId =
    options.projectId || (await readLocalProjectFile())?.projectId;
  if (!projectId) {
    failWith(
      isJson,
      noProject(
        "No project for this directory. Run `lmnr-cli project link` here, " +
          "or pass --project-id <id>.",
      ),
    );
  }

  const issuer = creds.issuer || DEFAULT_FRONTEND_URL;

  // Validate the session up-front so an expired grant maps to login_failed (6)
  // rather than a doomed mint's setup_key_failed (9).
  try {
    await refreshIfNeeded(creds);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      failWith(
        isJson,
        loginFailed("Session expired. Run `lmnr-cli login` first."),
      );
    }
    throw err;
  }

  let minted;
  try {
    minted = await mintProjectApiKey(
      issuer,
      creds.sessionToken,
      projectId,
      hostname(),
    );
  } catch (err) {
    failWith(isJson, setupKeyFailed(errorMessage(err)));
  }

  const result: ProjectMintKeyResult = {
    projectId,
    apiKey: minted.apiKey,
    apiKeyId: minted.apiKeyId ?? null,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // Bare key to stdout (pipe-friendly); the hint goes to stderr.
  process.stdout.write(minted.apiKey + "\n");
  process.stderr.write(
    `\n${pc.dim(`Set it in your environment (it is NOT written for you):`)}\n` +
      `  LMNR_PROJECT_API_KEY=${minted.apiKey}\n`,
  );
}
