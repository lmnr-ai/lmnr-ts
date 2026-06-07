import { execSync } from "node:child_process";
import { basename } from "node:path";

const GIT_TIMEOUT_MS = 1500;

export interface DeriveOptions {
  explicit?: string;
  cwd?: string;
}

/**
 * Derive a project name. First non-empty wins:
 *   1. `opts.explicit`
 *   2. git remote URL (last path segment, `.git` stripped)
 *   3. cwd basename
 *   4. literal `"default"`
 *
 * Then normalize: trim → lowercase → replace `[^a-z0-9-]` with `-` →
 * collapse repeated dashes → trim leading/trailing dashes → cap at 64 chars.
 * Empty after normalization falls back to `"default"`.
 */
export function deriveProjectName(opts: DeriveOptions = {}): string {
  const raw =
    firstNonEmpty(
      opts.explicit,
      tryGitRemoteName(opts.cwd ?? process.cwd()),
      basename(opts.cwd ?? process.cwd()),
    ) ?? "default";
  return normalize(raw);
}

/**
 * Derive a workspace name. Same fallback order, but NO normalization —
 * workspace names are human-readable. Default `"My Workspace"`.
 */
export function deriveWorkspaceName(opts: DeriveOptions = {}): string {
  return (
    firstNonEmpty(
      opts.explicit?.trim(),
      tryGitRemoteName(opts.cwd ?? process.cwd())?.trim(),
      basename(opts.cwd ?? process.cwd()).trim(),
    ) ?? "My Workspace"
  );
}

function firstNonEmpty(...candidates: (string | undefined | null)[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function tryGitRemoteName(cwd: string): string | undefined {
  try {
    const out = execSync("git remote -v", {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf-8")
      .split("\n")
      .find((line) => line.length > 0);
    if (!out) return undefined;
    // line shape: "origin\tgit@github.com:foo/bar.git (fetch)" or "origin\thttps://github.com/foo/bar.git (fetch)"
    const parts = out.split(/\s+/);
    const url = parts[1];
    if (!url) return undefined;
    return parseRepoNameFromUrl(url);
  } catch {
    return undefined;
  }
}

/**
 * `git@github.com:owner/repo.git` → `repo`
 * `https://github.com/owner/repo.git` → `repo`
 * `https://github.com/owner/repo` → `repo`
 */
export function parseRepoNameFromUrl(url: string): string | undefined {
  // Strip trailing `.git` and trailing slash.
  let s = url.trim();
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  // The last `:` or `/` separator marks the start of the path; we want the
  // segment after it.
  const sepIdx = Math.max(s.lastIndexOf("/"), s.lastIndexOf(":"));
  if (sepIdx < 0) return undefined;
  const tail = s.slice(sepIdx + 1);
  return tail.length > 0 ? tail : undefined;
}

function normalize(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length === 0) return "default";
  if (s.length > 64) s = s.slice(0, 64).replace(/-+$/, "");
  return s;
}
