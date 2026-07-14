import { access, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { errorMessage } from "@lmnr-ai/types";

import { downloadSkill } from "../skill/fetch-skill";
import { SKILL_NAME, skillSource } from "../skill/laminar-skill";

// Agent dirs we look for in the project root. Order matters only for the
// "none present" default below.
export const AGENT_DIRS = [".claude", ".cursor", ".codex", ".agents"] as const;

// When NO agent dir exists we default to writing the skill into BOTH
// `.claude/` (Claude Code reads `.claude/skills/`) and `.agents/`, so whichever
// agent the project later adopts can find it.
const DEFAULT_AGENT_DIRS = [".claude", ".agents"];

/** Find the agent dirs (of {@link AGENT_DIRS}) whose `<dir>/<...suffix>` exists under `cwd`. */
const findDirs = async (cwd: string, suffix: string[]): Promise<string[]> => {
  const found: string[] = [];
  for (const dir of AGENT_DIRS) {
    if (await dirExists(join(cwd, dir, ...suffix))) found.push(dir);
  }
  return found;
};

/**
 * Resolve the install targets for a fresh install (setup / `skill add`): every
 * present agent dir, or BOTH `.claude/` and `.agents/` when none exist
 * (`defaulted: true`).
 */
export const resolveInstallTargets = async (
  cwd: string,
): Promise<{ targets: string[]; defaulted: boolean }> => {
  const present = await findDirs(cwd, []);
  return present.length > 0
    ? { targets: present, defaulted: false }
    : { targets: DEFAULT_AGENT_DIRS, defaulted: true };
};

/**
 * Agent dirs under `cwd` that already hold an installed Laminar skill
 * (`<dir>/skills/<SKILL_NAME>`) — the replace targets for `skill update`.
 */
export const findInstalledSkillDirs = (cwd: string): Promise<string[]> =>
  findDirs(cwd, ["skills", SKILL_NAME]);

/**
 * Thrown by {@link installSkillInto} when the install fails midway: targets are
 * replaced sequentially, so `written` carries the files of every agent dir that
 * WAS already updated before the failure. Callers use it to report partial
 * state instead of pretending nothing was touched.
 */
export class SkillInstallError extends Error {
  constructor(
    cause: unknown,
    /** Absolute paths of files written before the failure (may be empty). */
    readonly written: string[],
  ) {
    super(errorMessage(cause));
    this.name = "SkillInstallError";
  }
}

/**
 * Fetch the pinned Laminar skill (`SKILL_NAME`) from the lmnr-skills repo and
 * REPLACE `<dir>/skills/<SKILL_NAME>` in each given agent dir with its full
 * tree (`SKILL.md`, `references/*.md`, ...). Downloads ONCE into a temp staging
 * dir (one network hit) and copies it into each target.
 *
 * Throws {@link SkillInstallError} on download / copy failure — callers own the
 * failure policy (`setup` is best-effort via {@link installSkill}; `skill add`
 * / `skill update` let the error envelope surface it).
 *
 * Returns the absolute paths of every written file.
 */
export const installSkillInto = async (
  cwd: string,
  agentDirs: string[],
): Promise<string[]> => {
  const staging = await mkdtemp(join(tmpdir(), "lmnr-skill-"));
  const written: string[] = [];
  try {
    await downloadSkill(staging);

    // Files relative to the staging root (e.g. "SKILL.md", "references/x.md").
    const relFiles = (await readdir(staging, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => relative(staging, join(d.parentPath, d.name)));

    for (const dir of agentDirs) {
      const skillRoot = join(cwd, dir, "skills", SKILL_NAME);
      // Replace, don't merge: `cp` alone would leave behind files that were
      // deleted upstream (e.g. a removed reference doc) from a prior install.
      await rm(skillRoot, { recursive: true, force: true });
      await mkdir(skillRoot, { recursive: true });
      await cp(staging, skillRoot, { recursive: true });
      for (const rel of relFiles) written.push(join(skillRoot, rel));
    }
    return written;
  } catch (err) {
    throw new SkillInstallError(err, written);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export interface InstallSkillResult {
  /** Absolute paths of every written file (SKILL.md + references/...). */
  written: string[];
  /** True when no agent dir existed and we defaulted to `.claude/` + `.agents/`. */
  defaulted: boolean;
  /**
   * True when the install failed (e.g. network failure) and was aborted.
   * `written` still lists any files written before the failure (targets are
   * replaced sequentially, so a mid-run failure leaves earlier agent dirs
   * updated); `defaulted` is false.
   */
  skipped: boolean;
}

/**
 * Best-effort skill install for `setup`: write the skill into every present
 * agent dir under `cwd`, or default to BOTH `.claude/` and `.agents/` when none
 * are present. Idempotent — overwrites on rerun.
 *
 * Skill install is the last, best-effort step of `setup`: a failure MUST NOT
 * break setup — on error we log a warning and return `skipped: true`, with
 * `written` still carrying any files a mid-run failure left in place.
 *
 * For .cursor/.codex the skills layout is not guaranteed to match CC; we write
 * the CC-guaranteed `skills/<SKILL_NAME>/` shape there too rather than
 * inventing a path that silently loads nothing.
 */
export async function installSkill(
  cwd: string = process.cwd(),
): Promise<InstallSkillResult> {
  const { targets, defaulted } = await resolveInstallTargets(cwd);
  try {
    const written = await installSkillInto(cwd, targets);
    return { written, defaulted, skipped: false };
  } catch (err) {
    const written = err instanceof SkillInstallError ? err.written : [];
    process.stderr.write(
      `Warning: could not install the Laminar skill (${skillSource()}): ` +
      `${errorMessage(err)}; skipping skill install.\n`,
    );
    if (written.length > 0) {
      process.stderr.write(
        `Warning: the skill was partially installed (${written.length} file(s) ` +
        "written before the failure); re-run `lmnr-cli skill add` to finish.\n",
      );
    }
    return { written, defaulted: false, skipped: true };
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
