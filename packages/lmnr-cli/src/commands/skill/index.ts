import { join } from "node:path";

import type { GlobalOpts } from "../../auth/with-client";
import { SKILL_NAME } from "../../skill/laminar-skill";
import { pc } from "../../utils/colors";
import {
  findInstalledSkillDirs,
  installSkillInto,
  resolveInstallTargets,
} from "../../utils/install-skill";
import { outputJson } from "../../utils/output";

/**
 * `skill add`: install the Laminar skill into every present agent dir
 * (`.claude` / `.cursor` / `.codex` / `.agents`), defaulting to `.claude` +
 * `.agents` when none exist — the same targeting as `setup`'s install step.
 * Idempotent: an already-installed skill is replaced with the fresh download.
 *
 * Unlike `setup` (where the install is best-effort), a download failure here
 * fails the command — installing the skill IS the command. Pure local handler:
 * the wrapper (`withLocalOpts`) owns the error envelope.
 */
export const handleSkillAdd = async (opts: GlobalOpts): Promise<void> => {
  const cwd = process.cwd();
  const { targets, defaulted } = await resolveInstallTargets(cwd);
  const written = await installSkillInto(cwd, targets);
  report("Installed", targets, written, defaulted, opts);
};

/**
 * `skill update`: re-fetch the Laminar skill and REPLACE every installed copy
 * (`<agent dir>/skills/laminar`) under the current directory. Only touches agent
 * dirs that already hold the skill — use `skill add` to install into new ones.
 */
export const handleSkillUpdate = async (opts: GlobalOpts): Promise<void> => {
  const cwd = process.cwd();
  const targets = await findInstalledSkillDirs(cwd);
  if (targets.length === 0) {
    throw new Error(
      `No installed Laminar skill found (looked for <agent dir>/skills/${SKILL_NAME} in ` +
      `.claude, .cursor, .codex, .agents). Run \`lmnr-cli skill add\` to install it.`,
    );
  }
  const written = await installSkillInto(cwd, targets);
  report("Updated", targets, written, false, opts);
};

const report = (
  verb: string,
  targets: string[],
  written: string[],
  defaulted: boolean,
  opts: GlobalOpts,
): void => {
  const skillDirs = targets.map((dir) => join(dir, "skills", SKILL_NAME));
  if (opts.json) {
    outputJson({ skillDirs, files: written });
    return;
  }
  const note = defaulted ? pc.dim(" (no agent dir found; defaulted to .claude and .agents)") : "";
  process.stderr.write(
    `${pc.green("✓")} ${verb} the Laminar skill in ${skillDirs.join(", ")}${note}\n`,
  );
};
