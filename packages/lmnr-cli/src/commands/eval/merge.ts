import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { STATE_FILE } from "./layout";

/** Task name → digest. */
export type TaskDigests = Record<string, string>;

export interface MergePlan {
  /** Tasks to take from the remote version (replacing the local copy). */
  take: string[];
  /** Tasks to delete locally (deleted remotely, unchanged locally). */
  remove: string[];
  /** Tasks changed differently on both sides. */
  conflicts: string[];
}

/**
 * Task-level 3-way merge of a local task set copy with a remote version, both
 * against the version the copy is based on: a task changed on one side takes
 * that side, a task changed the same way on both sides is left alone, and a
 * task changed differently on both sides is a conflict.
 */
export const planMerge = (
  base: TaskDigests,
  local: TaskDigests,
  remote: TaskDigests,
): MergePlan => {
  const plan: MergePlan = { take: [], remove: [], conflicts: [] };
  const names = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  for (const name of [...names].sort()) {
    const [b, l, r] = [base[name], local[name], remote[name]];
    if (l === r) continue;
    if (l === b) {
      if (r === undefined) plan.remove.push(name);
      else plan.take.push(name);
    } else if (r !== b) {
      plan.conflicts.push(name);
    }
  }
  return plan;
};

/**
 * Apply a conflict-free plan: copy the remote tasks over, delete the removed
 * ones, and take the remote version's files outside of task dirs (READMEs).
 */
export const applyMerge = async (
  setDir: string,
  remoteDir: string,
  plan: MergePlan,
  remoteTasks: TaskDigests,
): Promise<void> => {
  await mkdir(setDir, { recursive: true });
  for (const name of plan.remove) {
    await rm(path.join(setDir, name), { recursive: true, force: true });
  }
  for (const name of plan.take) {
    const target = path.join(setDir, name);
    await rm(target, { recursive: true, force: true });
    await cp(path.join(remoteDir, name), target, { recursive: true });
  }
  for (const entry of await readdir(remoteDir, { withFileTypes: true })) {
    if (entry.name === STATE_FILE || entry.name in remoteTasks) continue;
    await cp(path.join(remoteDir, entry.name), path.join(setDir, entry.name), {
      recursive: true,
    });
  }
};
