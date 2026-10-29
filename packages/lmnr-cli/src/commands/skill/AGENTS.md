# Skill install (`skill`, `src/utils/install-skill.ts`)

- One shared core, two failure policies: `installSkillInto(cwd, agentDirs)` downloads once
  into a temp staging dir and REPLACES `<dir>/skills/laminar` in each target, and it THROWS
  on failure. `setup` wraps it in `installSkill()` (best-effort: warn + `skipped: true`,
  never breaks setup), while `skill add` / `skill update` let the error envelope surface the
  failure — installing the skill IS the command there. Don't collapse the two policies.
- Target resolution is split by intent: `resolveInstallTargets` (present agent dirs, else
  default `.claude` + `.agents`) is for fresh installs (setup / `skill add`);
  `findInstalledSkillDirs` (dirs already holding `skills/laminar`) is for `skill update`,
  which must NOT create new copies and errors when none are installed.
- `skill add` / `skill update` are local-only commands (`withLocalOpts`) — no login, no
  client; the only network hit is the giget download of the skill tarball.
