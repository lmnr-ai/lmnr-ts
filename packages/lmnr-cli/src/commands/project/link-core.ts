import { hostname } from "node:os";
import { relative } from "node:path";

import { LaminarClient, type ProjectKeyProbe } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { type MintedApiKey, mintProjectApiKey } from "../../auth/api-key";
import { type Credentials } from "../../auth/credentials";
import { envHttpPort, refreshIfNeeded, SessionExpiredError } from "../../auth/resolve";
import {
  EXIT_ENV_WRITE_FAILED,
  failWith,
  keyMismatch,
  keyProbeFailed,
  loginFailed,
  setupKeyFailed,
} from "../../errors";
import { pc } from "../../utils/colors";
import {
  type EnvKeyLocation,
  isPathGitIgnored,
  resolveEnvWriteTarget,
  writeEnvFile,
} from "../../utils/env-file";
import { type LocalProjectFile } from "../../utils/local-project-file";

/**
 * Resolve which project a project API key belongs to (`POST /v1/cli/project`).
 * Auth is the user's JWT, not the project key — the server also checks the user
 * is a member of the resolved project.
 */
export async function probeProjectKey(
  creds: Credentials,
  apiKey: string,
  baseUrl: string,
): Promise<ProjectKeyProbe> {
  const updated = await refreshIfNeeded(creds);
  const client = new LaminarClient({
    baseUrl,
    port: envHttpPort(),
    auth: { type: "userToken", token: updated.accessToken, projectId: "" },
  });
  return client.cli.resolveProjectByApiKey(apiKey);
}

/** Outcome of {@link ensureProjectKey}: what (if anything) was minted / written. */
export interface EnsureKeyResult {
  /** The key written to .env, or null when an existing matching key was reused. */
  apiKey: string | null;
  /** The .env(.local) path written, or null when nothing was written. */
  envFileUpdated: string | null;
  /** Full mint metadata when a key was minted, else null. */
  keyMeta: MintedApiKey | null;
  /** On the "warn" path, the different project's id (for `--json`); null otherwise. */
  mismatchProjectId: string | null;
}

/**
 * Ensure a usable Project API Key for the linked project — shared by `setup` and
 * `project link`. Probes an existing `LMNR_PROJECT_API_KEY`, reuses it if it
 * already points here, and otherwise mints (and writes, when `writeEnv`). Never
 * clobbers a valid key for a different project, and aborts rather than minting
 * when the key can't be verified (transient blip). `link` is mutated in place to
 * backfill display details learned while minting.
 *
 * `onKeyMismatch` is the only caller difference: for a valid key on a DIFFERENT
 * project, `"fail"` (setup) exits `key_mismatch`; `"warn"` (`project link`) warns
 * and proceeds so the re-link goes through.
 */
export async function ensureProjectKey(params: {
  creds: Credentials;
  link: LocalProjectFile;
  existingKey: EnvKeyLocation | null;
  cwd: string;
  issuer: string;
  userBaseUrl: string;
  writeEnv: boolean;
  isJson: boolean;
  onKeyMismatch?: "fail" | "warn";
}): Promise<EnsureKeyResult> {
  const { creds, link, existingKey, cwd, issuer, userBaseUrl, writeEnv, isJson } = params;
  const onKeyMismatch = params.onKeyMismatch ?? "fail";

  let apiKey: string | null = null;
  let envFileUpdated: string | null = null;
  let keyMeta: MintedApiKey | null = null;
  let mismatchProjectId: string | null = null;

  let needMint = true;
  if (existingKey) {
    let probe: ProjectKeyProbe;
    try {
      probe = await probeProjectKey(creds, existingKey.value, userBaseUrl);
    } catch (err) {
      // An expired grant from refreshIfNeeded maps to login_failed (6), not an
      // uncoded exit 1 — same contract the callers follow.
      if (err instanceof SessionExpiredError) {
        failWith(isJson, loginFailed("Session expired. Run `lmnr-cli login` first."));
      }
      throw err;
    }
    const where =
      existingKey.source.type === "process-env"
        ? "your environment"
        : relative(cwd, existingKey.source.path);

    if (probe.status === "unverifiable") {
      // Couldn't verify the key — abort rather than mint over a possibly-valid key.
      failWith(
        isJson,
        keyProbeFailed(
          `Couldn't verify the existing Project API Key in ${where} (network or server error). ` +
          "Check your connection and re-run.",
        ),
      );
    } else if (probe.status === "ok" && probe.projectId === link.projectId) {
      // Already set for this project — no mint, no write.
      needMint = false;
      if (!isJson) {
        process.stderr.write(`${pc.green("✓")} Project API Key already set in ${where}\n`);
      }
    } else if (probe.status === "ok" && onKeyMismatch === "warn") {
      // Valid key for a different project — warn instead of clobbering and let the
      // re-link proceed; the user replaces it via `lmnr-cli project mint-key`.
      needMint = false;
      mismatchProjectId = probe.projectId;
      if (!isJson) {
        process.stderr.write(
          `${pc.yellow("⚠")} The Project API Key in ${where} belongs to a different ` +
          `project (${probe.projectId}), not the one you're linking here (${link.projectId}). ` +
          `Mint one for this project with \`lmnr-cli project mint-key\` and replace it ` +
          `in ${where}.\n`,
        );
      }
    } else if (probe.status === "ok") {
      // Valid key for a different project — abort so the user resolves it deliberately.
      failWith(
        isJson,
        keyMismatch(
          `The Project API Key in ${where} belongs to a different project (${probe.projectId}), ` +
          `not the one linked here (${link.projectId}). Remove or update it, then re-run.`,
        ),
      );
    } else if (!isJson) {
      // invalid / revoked (401) — minting a fresh key is the correct recovery.
      process.stderr.write(
        `${pc.yellow("⚠")} Existing Project API Key in ${where} is invalid or revoked, ` +
        `minting a new one\n`,
      );
    }
  }

  if (needMint) {
    try {
      keyMeta = await mintProjectApiKey(issuer, creds.sessionToken, link.projectId, hostname());
    } catch (err) {
      failWith(isJson, setupKeyFailed(errorMessage(err)));
    }
    apiKey = keyMeta.apiKey;

    // Backfill display details learned while minting.
    if (!link.projectName && keyMeta.projectName) link.projectName = keyMeta.projectName;
    if (!link.workspaceName && keyMeta.workspaceName) link.workspaceName = keyMeta.workspaceName;
    if (!link.workspaceId && keyMeta.workspaceId) link.workspaceId = keyMeta.workspaceId;

    if (writeEnv) {
      const target = await resolveEnvWriteTarget(cwd, existingKey);
      try {
        const result = await writeEnvFile(target, apiKey);
        envFileUpdated = result.path;
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
          `\n${pc.red("ERROR")}: failed to write ${target}: ${errorMessage(err)}\n` +
          pc.dim("Your API key (set it manually):") +
          `\n  LMNR_PROJECT_API_KEY=${apiKey}\n\n`,
        );
        if (isJson) {
          process.stdout.write(
            JSON.stringify({
              error: "env_write_failed",
              apiKey,
              projectId: link.projectId,
              message: errorMessage(err),
            }) + "\n",
          );
        }
        process.exit(EXIT_ENV_WRITE_FAILED);
      }
    }
  }

  return { apiKey, envFileUpdated, keyMeta, mismatchProjectId };
}
