import { hostname } from "node:os";
import { relative } from "node:path";

import { LaminarClient, type ProjectKeyProbe } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { type MintedApiKey, mintProjectApiKey } from "../../auth/api-key";
import { type Credentials } from "../../auth/credentials";
import { envHttpPort, refreshIfNeeded } from "../../auth/resolve";
import { pc } from "../../utils/colors";
import {
  type EnvKeyLocation,
  isPathGitIgnored,
  resolveEnvWriteTarget,
  writeEnvFile,
} from "../../utils/env-file";
import { type LocalProjectFile } from "../../utils/local-project-file";
import { emitError } from "../../utils/output";

/**
 * Onboarding exit codes (machine-readable contract — each distinct so
 * automation can branch on the failure mode). Shared by `setup` and
 * `project link` so both commands report identical codes for the same failures.
 *
 *   4  no_access            — user lacks access to the target project
 *   6  login_failed         — device-flow login failed / no creds after login
 *   7  no_project           — no project to select (and none could be created)
 *   8  env_write_failed     — minted a key but couldn't write ./.env
 *   9  setup_key_failed     — POST /api/cli/api-key failed
 *   10 list_projects_failed — GET /v1/cli/projects (discovery) failed
 *   11 key_probe_failed     — couldn't verify the existing key (network/server)
 *   12 key_mismatch         — existing key belongs to a different project
 */
export const EXIT_NO_ACCESS = 4;
export const EXIT_LOGIN_FAILED = 6;
export const EXIT_NO_PROJECT = 7;
export const EXIT_ENV_WRITE_FAILED = 8;
export const EXIT_SETUP_KEY_FAILED = 9;
export const EXIT_LIST_PROJECTS_FAILED = 10;
export const EXIT_KEY_PROBE_FAILED = 11;
export const EXIT_KEY_MISMATCH = 12;

/**
 * Resolve which project an existing project API key belongs to, via the
 * user-token CLI endpoint (`POST /v1/cli/project`, key in body). By this point
 * the CLI is already logged in, so we authenticate as the user (JWT bearer)
 * rather than re-deriving auth from the project key itself. The server also
 * confirms the user is a member of the resolved project.
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
  /**
   * When `onKeyMismatch: "warn"` and the existing key belongs to a DIFFERENT
   * project: that project's id (so the caller can surface it in `--json`). Null
   * otherwise. Only ever set on the "warn" path — "fail" exits instead.
   */
  mismatchProjectId: string | null;
}

/**
 * Ensure a usable Project API Key for the directory-linked project (SPEC 36-42),
 * the shared key-handling primitive for `setup` and `project link`:
 *  - probe an existing `LMNR_PROJECT_API_KEY` (process.env → .env.local → .env),
 *  - reuse it untouched when it already points at THIS project,
 *  - refuse to clobber a valid key that belongs to a DIFFERENT project,
 *  - abort (don't mint) when the key can't be verified (network/server blip),
 *  - otherwise mint a fresh key and (when `writeEnv`) write it to .env(.local).
 *
 * `link` is mutated in place to backfill display details learned while minting.
 * On a hard failure it emits a coded error and exits — the SAME exit codes for
 * both callers. Returns what was minted/written on success.
 *
 * `onKeyMismatch` controls the one place the two callers differ: a valid key
 * that belongs to a DIFFERENT project. `"fail"` (default, `setup`) refuses to
 * clobber and exits `key_mismatch` (12). `"warn"` (`project link`) instead warns
 * and returns — the user asked to re-point here, so we let the re-link proceed
 * and point them at `lmnr-cli project mint-key` to replace the stale key themselves.
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
    const probe = await probeProjectKey(creds, existingKey.value, userBaseUrl);
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
    } else if (probe.status === "ok" && onKeyMismatch === "warn") {
      // Valid key for a DIFFERENT project, but the caller (`project link`) asked
      // to re-point here anyway. Don't clobber the key — warn and let the re-link
      // proceed; the user replaces the key themselves via `lmnr-cli project mint-key`.
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
        `${pc.yellow("⚠")} Existing Project API Key in ${where} is invalid or revoked, ` +
        `minting a new one\n`,
      );
    }
  }

  if (needMint) {
    try {
      keyMeta = await mintProjectApiKey(issuer, creds.sessionToken, link.projectId, hostname());
    } catch (err) {
      emitError(isJson, "setup_key_failed", errorMessage(err));
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
