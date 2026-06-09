import { access, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { downloadSkill } from "../skill/fetch-skill";
import { skillSource, SKILL_NAME } from "../skill/laminar-skill";

// Agent dirs we look for in the project root. Order matters only for the
// "none present" default below.
const AGENT_DIRS = [".claude", ".cursor", ".codex", ".agents"] as const;

// Claude Code reads `.claude/skills/`. When NO agent dir exists we default to
// `.claude/skills/<SKILL_NAME>/` — NEVER `.agents/` (CC does not load `.agents/`).
const DEFAULT_AGENT_DIR = ".claude";

export interface InstallSkillResult {
  /** Absolute paths of every written file (SKILL.md + references/...). */
  written: string[];
  /** True when no agent dir existed and we defaulted to `.claude/`. */
  defaulted: boolean;
  /**
   * True when the skill could not be fetched (network failure) and install was
   * skipped. `written` is empty and `defaulted` is false.
   */
  skipped: boolean;
}

/**
 * Fetch the pinned Laminar skill (`SKILL_NAME`) from the lmnr-skills repo and
 * write its full tree into every present agent dir under `cwd`
 * (`<dir>/skills/<SKILL_NAME>/SKILL.md`, `.../references/*.md`, ...). If none
 * are present, default to `.claude/`. Idempotent — overwrites on rerun.
 *
 * We download ONCE into a temp staging dir (one network hit) and copy it into
 * each agent dir. Skill install is the last, best-effort step of `setup`: a
 * download failure MUST NOT break setup — on error we log a warning and return
 * `{ written: [], defaulted: false, skipped: true }`.
 *
 * For .cursor/.codex the skills layout is not guaranteed to match CC; we write
 * the CC-guaranteed `skills/<SKILL_NAME>/` shape there too rather than
 * inventing a path that silently loads nothing.
 */
export async function installSkill(
  cwd: string = process.cwd(),
): Promise<InstallSkillResult> {
  const staging = await mkdtemp(join(tmpdir(), "lmnr-skill-"));
  try {
    try {
      await downloadSkill(staging);
    } catch (err) {
      process.stderr.write(
        `Warning: could not fetch the Laminar skill (${skillSource()}): ` +
          `${describeError(err)}; skipping skill install.\n`,
      );
      return { written: [], defaulted: false, skipped: true };
    }

    // Files relative to the staging root (e.g. "SKILL.md", "references/x.md").
    const relFiles = (await readdir(staging, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => relative(staging, join(d.parentPath, d.name)));

    const present: string[] = [];
    for (const dir of AGENT_DIRS) {
      if (await dirExists(join(cwd, dir))) present.push(dir);
    }

    const targets = present.length > 0 ? present : [DEFAULT_AGENT_DIR];
    const written: string[] = [];
    for (const dir of targets) {
      const skillRoot = join(cwd, dir, "skills", SKILL_NAME);
      await mkdir(skillRoot, { recursive: true });
      await cp(staging, skillRoot, { recursive: true });
      for (const rel of relFiles) written.push(join(skillRoot, rel));
    }

    return { written, defaulted: present.length === 0, skipped: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
