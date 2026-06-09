// Source coordinates for the Laminar agent skill, fetched from the public
// lmnr-skills repo at `lmnr-cli setup` time via giget (see
// ../utils/install-skill.ts).

// TODO(skill-pin): lmnr-skills has no tagged release yet, so we pin the `main`
// branch — installs always get the latest, but are NOT deterministic. Switch
// SKILL_REF to a semver tag (e.g. "v1.0.0") once the skills repo cuts a release
// to get reproducible installs that we bump deliberately.
// TODO(skill-choice): `laminar-quickstart-trace` is the placeholder skill for
// now; make the skill selection configurable later.
export const SKILL_REPO = "lmnr-ai/lmnr-skills";
export const SKILL_REF = "main";
export const SKILL_NAME = "laminar-quickstart-trace";

/**
 * giget source for the pinned skill subdir: `github:<owner>/<repo>/<subdir>#<ref>`.
 * giget resolves this against codeload.github.com, gunzips, untars, strips the
 * `repo-<ref>/` prefix, and extracts only the subdir — all the mechanics we'd
 * otherwise hand-roll.
 */
export function skillSource(): string {
  return `github:${SKILL_REPO}/skills/${SKILL_NAME}#${SKILL_REF}`;
}
