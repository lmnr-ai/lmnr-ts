/**
 * Detects the release (usually the git SHA) of the running code.
 *
 * Laminar groups an agent's traces into versions by release, so a detected
 * value must change on every code deploy. A value that can stay the same
 * across deploys would merge two versions; such sources are left out on
 * purpose. Keep the order line-comparable with the Python SDK's `release.py`.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_RELEASE_LENGTH = 128;

// The GitHub Actions commit (CI runs, e.g. evals), explicitly set releases,
// then platform commit SHAs.
export const RELEASE_ENV_VARS = [
  "GITHUB_SHA",
  "SENTRY_RELEASE",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
  "HEROKU_BUILD_COMMIT",
  "SOURCE_VERSION", // Heroku
  "CODEBUILD_RESOLVED_SOURCE_VERSION",
  "CIRCLE_SHA1",
  // Deploy ids that change on every deploy but aren't commit SHAs.
  "K_REVISION", // Cloud Run
  "GAE_DEPLOYMENT_ID",
  "FLY_IMAGE_REF",
] as const;

/**
 * The first available of: `explicit`, `LMNR_RELEASE`, a known platform
 * variable, a numeric AWS Lambda version, the checked-out git commit.
 */
export const detectRelease = (explicit?: string): string | undefined => {
  const candidates: (() => string | undefined)[] = [
    () => explicit,
    () => env("LMNR_RELEASE"),
    ...RELEASE_ENV_VARS.map((name) => () => env(name)),
    lambdaVersion,
    gitHead,
  ];
  for (const candidate of candidates) {
    const release = clean(candidate());
    if (release) {
      return release;
    }
  }
  return undefined;
};

// Edge runtimes may have no `process`.
const env = (name: string): string | undefined => {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
};

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // By code point, so a cut never splits a surrogate pair.
  const chars = Array.from(trimmed);
  return chars.length > MAX_RELEASE_LENGTH
    ? chars.slice(0, MAX_RELEASE_LENGTH).join("")
    : trimmed;
};

const lambdaVersion = (): string | undefined => {
  // `$LATEST` stays the same across deploys; only published versions are numbered.
  const version = env("AWS_LAMBDA_FUNCTION_VERSION");
  const fn = env("AWS_LAMBDA_FUNCTION_NAME");
  if (!version || !/^\d+$/.test(version) || !fn) {
    return undefined;
  }
  return `${fn}:${version}`;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The commit `.git/HEAD` points at, read from disk without running git. */
const gitHead = (): string | undefined => {
  try {
    const gitDir = findGitDir(process.cwd());
    if (gitDir === undefined) {
      return undefined;
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) {
      return head;
    }
    const ref = head.slice("ref:".length).trim();
    // A linked worktree keeps its refs in the main repository.
    const commonFile = join(gitDir, "commondir");
    const commonDir = isFile(commonFile)
      ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
      : gitDir;
    for (const refsDir of new Set([gitDir, commonDir])) {
      const refFile = join(refsDir, ref);
      if (isFile(refFile)) {
        return readFileSync(refFile, "utf8").trim();
      }
    }
    const packedRefs = join(commonDir, "packed-refs");
    if (isFile(packedRefs)) {
      for (const line of readFileSync(packedRefs, "utf8").split("\n")) {
        const space = line.indexOf(" ");
        if (space !== -1 && line.slice(space + 1).trim() === ref) {
          return line.slice(0, space);
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const findGitDir = (start: string): string | undefined => {
  let directory = resolve(start);
  for (;;) {
    const dotGit = join(directory, ".git");
    if (isDirectory(dotGit)) {
      return dotGit;
    }
    if (isFile(dotGit)) {
      // Worktrees and submodules: `.git` is a file with `gitdir: <path>`.
      const content = readFileSync(dotGit, "utf8").trim();
      if (content.startsWith("gitdir:")) {
        return resolve(directory, content.slice("gitdir:".length).trim());
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};
