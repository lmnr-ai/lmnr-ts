// Source coordinates for the Laminar agent skill, fetched from the public
// lmnr-skills repo at `lmnr-cli setup` time via giget (see
// ../utils/install-skill.ts).

export const SKILL_REPO = "lmnr-ai/lmnr-skills";
export const SKILL_REF = "main";
export const SKILL_NAME = "laminar";

/**
 * giget source for the pinned skill subdir: `github:<owner>/<repo>/<subdir>#<ref>`.
 * giget resolves this against codeload.github.com, gunzips, untars, strips the
 * `repo-<ref>/` prefix, and extracts only the subdir — all the mechanics we'd
 * otherwise hand-roll.
 */
export function skillSource(): string {
  return `github:${SKILL_REPO}/skills/${SKILL_NAME}#${SKILL_REF}`;
}
