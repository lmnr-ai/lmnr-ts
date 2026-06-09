import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LAMINAR_SKILL_MD,
  SKILL_DIR_NAME,
  SKILL_FILE_NAME,
} from "../skill/laminar-skill";

// Agent dirs we look for in the project root. Order matters only for the
// "none present" default below.
const AGENT_DIRS = [".claude", ".cursor", ".codex", ".agents"] as const;

// Claude Code reads `.claude/skills/`. When NO agent dir exists we default to
// `.claude/skills/laminar/` — NEVER `.agents/` (CC does not load `.agents/`).
const DEFAULT_AGENT_DIR = ".claude";

export interface InstallSkillResult {
  /** Absolute paths of the written SKILL.md files. */
  written: string[];
  /** True when no agent dir existed and we defaulted to `.claude/`. */
  defaulted: boolean;
}

/**
 * Write the Laminar skill into every present agent dir under `cwd`
 * (`<dir>/skills/laminar/SKILL.md`). If none are present, default to
 * `.claude/skills/laminar/SKILL.md`. Idempotent — overwrites on rerun.
 *
 * For .cursor/.codex the skills layout is not guaranteed to match CC; we write
 * the CC-guaranteed `skills/laminar/SKILL.md` shape there too rather than
 * inventing a path that silently loads nothing.
 */
export async function installSkill(
  cwd: string = process.cwd(),
): Promise<InstallSkillResult> {
  const present: string[] = [];
  for (const dir of AGENT_DIRS) {
    if (await dirExists(join(cwd, dir))) present.push(dir);
  }

  const targets = present.length > 0 ? present : [DEFAULT_AGENT_DIR];
  const written: string[] = [];
  for (const dir of targets) {
    const skillDir = join(cwd, dir, "skills", SKILL_DIR_NAME);
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, SKILL_FILE_NAME);
    await writeFile(filePath, LAMINAR_SKILL_MD, "utf8");
    written.push(filePath);
  }

  return { written, defaulted: present.length === 0 };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
