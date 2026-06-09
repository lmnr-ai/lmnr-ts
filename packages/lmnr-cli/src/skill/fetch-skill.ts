import { downloadTemplate } from "giget";

import { skillSource } from "./laminar-skill";

/**
 * Download the pinned Laminar skill subtree into `dir` using giget.
 *
 * giget owns every quirk we'd otherwise hand-roll: the codeload tarball URL,
 * gunzip, untar, stripping the `repo-<ref>/` leading segment, subdir filtering,
 * ref pinning, and a cache-first/offline-aware fetch (`preferOffline`). `force`
 * overwrites `dir` so reruns are idempotent.
 *
 * Throws on network / resolve / extract errors — callers (skill install is
 * best-effort) catch and skip.
 */
export async function downloadSkill(dir: string): Promise<void> {
  await downloadTemplate(skillSource(), {
    dir,
    force: true,
    preferOffline: true,
  });
}
