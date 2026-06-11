import { downloadTemplate } from "giget";

import { skillSource } from "./laminar-skill";

/**
 * Download the pinned Laminar skill subtree into `dir` using giget.
 *
 * giget owns every quirk we'd otherwise hand-roll: the codeload tarball URL,
 * gunzip, untar, stripping the `repo-<ref>/` leading segment, subdir filtering,
 * and ref pinning. `force` overwrites `dir` so reruns are idempotent.
 *
 * We deliberately do NOT pass `preferOffline`: giget caches the tarball keyed by
 * REF name, and SKILL_REF is a moving branch (`main` / a feature branch), so
 * `preferOffline` would reuse a stale cached tarball forever — reinstalling
 * files that were since deleted upstream. Without it, giget revalidates via the
 * stored etag and re-downloads when the branch moved.
 *
 * Throws on network / resolve / extract errors — callers (skill install is
 * best-effort) catch and skip.
 */
export async function downloadSkill(dir: string): Promise<void> {
  await downloadTemplate(skillSource(), {
    dir,
    force: true,
  });
}
