import { hostname } from "node:os";

import { errorMessage } from "@lmnr-ai/types";

import { mintProjectApiKey } from "../../auth/api-key";
import { safeReadCredentials } from "../../auth/credentials";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { pc } from "../../utils/colors";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { emitError } from "../../utils/output";
import { EXIT_LOGIN_FAILED, EXIT_NO_PROJECT, EXIT_SETUP_KEY_FAILED } from "./link-core";

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
 * project (or `--project-id`) and PRINT it, so the user can paste it into their
 * `.env` (or wherever). Unlike `setup` / `project link`, it deliberately does NOT
 * write `.env` — it hands you the key and stays out of your files.
 *
 * Minting goes through the shared `mintProjectApiKey` (the same call `setup` and
 * `plugin add` use). Requires an existing login. Manages its own exit codes /
 * `--json` contract like the other onboarding commands. The bare key goes to
 * stdout (pipe / copy-paste friendly); everything else is on stderr.
 */
export async function handleProjectMintKey(options: ProjectMintKeyOptions): Promise<void> {
  const isJson = options.json === true;

  const creds = await safeReadCredentials();
  if (!creds) {
    emitError(isJson, "login_failed", "Not authenticated. Run `lmnr-cli login` first.");
    process.exit(EXIT_LOGIN_FAILED);
  }

  const projectId = options.projectId || (await readLocalProjectFile())?.projectId;
  if (!projectId) {
    emitError(
      isJson,
      "no_project",
      "No project for this directory. Run `lmnr-cli project link` here, or pass --project-id <id>.",
    );
    process.exit(EXIT_NO_PROJECT);
  }

  const issuer = creds.issuer || DEFAULT_FRONTEND_URL;

  let minted;
  try {
    minted = await mintProjectApiKey(issuer, creds.sessionToken, projectId, hostname());
  } catch (err) {
    emitError(isJson, "setup_key_failed", errorMessage(err));
    process.exit(EXIT_SETUP_KEY_FAILED);
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

  // The bare key is the data — stdout, so it pipes / copies cleanly. The hint
  // for what to do with it is a message — stderr, keeping stdout just the key.
  process.stdout.write(minted.apiKey + "\n");
  process.stderr.write(
    `\n${pc.dim(`Set it in your environment (it is NOT written for you):`)}\n` +
    `  LMNR_PROJECT_API_KEY=${minted.apiKey}\n`,
  );
}
