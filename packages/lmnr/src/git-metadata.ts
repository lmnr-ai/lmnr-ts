/**
 * Best-effort collection of git state for trace metadata.
 *
 * Collected once per process at `Laminar.initialize()` and merged into the
 * global trace metadata at the LOWEST precedence, so both `LMNR_TRACE_METADATA`
 * and the explicit `metadata` init argument can override any of the keys. The
 * keys land on every span as `lmnr.association.properties.metadata.git.*` and
 * flow into `traces.metadata` server-side with no backend changes.
 *
 * Collection must NEVER crash or block initialization: every git subprocess is
 * wrapped in a try/catch with a short timeout, and a gitless environment
 * (CI checkout without `.git`, git binary missing, non-Node runtime) degrades
 * to well-known CI environment variables, then to nothing.
 *
 * Set `LMNR_DISABLE_GIT_METADATA` to a truthy value ("true", "1", "yes", "on")
 * to disable collection entirely.
 *
 * This is a cross-language parity surface with the Python SDK
 * `lmnr-python/src/lmnr/sdk/git_metadata.py` — keep the two line-comparable.
 */

import { execSync } from "node:child_process";

export const GIT_COMMIT_METADATA_KEY = "git.commit";
export const GIT_BRANCH_METADATA_KEY = "git.branch";
export const GIT_DIRTY_METADATA_KEY = "git.dirty";

const GIT_TIMEOUT_MS = 1500;

const TRUTHY = new Set(["true", "1", "yes", "on"]);

// [commit env var, branch env var] per CI/deploy platform, checked in order.
// Used only when git itself is unavailable — e.g. gitless CI checkouts.
const CI_ENV_VARS: [string, string][] = [
  ["GITHUB_SHA", "GITHUB_REF_NAME"],
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF"],
  ["CI_COMMIT_SHA", "CI_COMMIT_REF_NAME"],
  ["CIRCLE_SHA1", "CIRCLE_BRANCH"],
  ["RENDER_GIT_COMMIT", "RENDER_GIT_BRANCH"],
  ["RAILWAY_GIT_COMMIT_SHA", "RAILWAY_GIT_BRANCH"],
];

/** Run a git command, returning its stripped stdout or undefined on ANY failure. */
const runGit = (args: string, cwd?: string): string | undefined => {
  try {
    return execSync(`git ${args}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf-8")
      .trim();
  } catch {
    return undefined;
  }
};

// Process-level opt-out recorded by `Laminar.initialize({ disableGitMetadata:
// true })`. Kept here (not on the Laminar class) so EVERY collection point —
// global trace metadata AND eval run metadata — honors the same flag without
// re-plumbing the init option through each call site.
let optedOut = false;

/** Record the initialize()-time opt-out for later collection points. */
export const setGitMetadataDisabled = (disabled: boolean) => {
  optedOut = disabled;
};

const gitMetadataDisabled = (): boolean => {
  if (optedOut) {
    return true;
  }
  const disabled = process?.env?.LMNR_DISABLE_GIT_METADATA;
  return disabled !== undefined && TRUTHY.has(disabled.trim().toLowerCase());
};

let cached: Record<string, string | boolean> | undefined = undefined;

/** Reset the process-level cache. Exposed for tests only. */
export const resetGitMetadataCache = () => {
  cached = undefined;
};

/**
 * Collect `git.commit` / `git.branch` / `git.dirty`, best-effort.
 *
 * Returns {} when collection is disabled — via the `disableGitMetadata`
 * option to `Laminar.initialize()` or the LMNR_DISABLE_GIT_METADATA env var.
 * The disabled check runs on every call (NOT inside the cache) so an opt-out
 * recorded after a prior collection still applies.
 *
 * Collection itself is cached for the process lifetime (git state is fixed
 * once the process is running; re-running subprocesses per
 * initialize()/evaluate() call would only add latency). Tests that vary cwd
 * or env must call {@link resetGitMetadataCache}.
 *
 * `git.branch` is omitted on a detached HEAD, and `git.dirty` counts only
 * tracked-file changes (untracked build artifacts should not flip it).
 *
 * @param cwd - Directory to collect from. Defaults to `process.cwd()`.
 */
export const collectGitMetadata = (
  cwd?: string,
): Record<string, string | boolean> => {
  if (gitMetadataDisabled()) {
    return {};
  }
  if (cached !== undefined) {
    return cached;
  }
  cached = doCollect(cwd);
  return cached;
};

const doCollect = (cwd?: string): Record<string, string | boolean> => {
  // execSync only exists on Node-compatible runtimes; edge/browser bundles may
  // stub node:child_process, so guard like getLangVersion does.
  if (!process?.versions?.node || typeof execSync !== "function") {
    return collectFromCiEnv();
  }

  const metadata: Record<string, string | boolean> = {};
  const commit = runGit("rev-parse HEAD", cwd);
  if (commit) {
    metadata[GIT_COMMIT_METADATA_KEY] = commit;
    const branch = runGit("rev-parse --abbrev-ref HEAD", cwd);
    if (branch && branch !== "HEAD") {
      metadata[GIT_BRANCH_METADATA_KEY] = branch;
    }
    const status = runGit("status --porcelain --untracked-files=no", cwd);
    if (status !== undefined) {
      metadata[GIT_DIRTY_METADATA_KEY] = status.length > 0;
    }
    return metadata;
  }

  // Not a git repo, no git binary, or an unborn HEAD — fall back to CI env
  // vars (a gap in Braintrust's approach: gitless CI checkouts get nothing).
  return collectFromCiEnv();
};

const collectFromCiEnv = (): Record<string, string | boolean> => {
  const metadata: Record<string, string | boolean> = {};
  for (const [commitVar, branchVar] of CI_ENV_VARS) {
    const envCommit = process?.env?.[commitVar];
    if (envCommit) {
      metadata[GIT_COMMIT_METADATA_KEY] = envCommit;
      const envBranch = process?.env?.[branchVar];
      if (envBranch) {
        metadata[GIT_BRANCH_METADATA_KEY] = envBranch;
      }
      break;
    }
  }
  return metadata;
};
