import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

/** Top-level entry (a task, or a file or dir beside the tasks) → digest. */
export type TaskDigests = Record<string, string>;

export interface MergePlan {
  /** Entries to take from the remote version (replacing the local copy). */
  take: string[];
  /** Entries to delete locally (deleted remotely, unchanged locally). */
  remove: string[];
  /** Entries changed differently on both sides. */
  conflicts: string[];
}

/**
 * 3-way merge of a local task set copy with a remote version, entry by
 * top-level entry (each task, and each file or dir beside them), both against
 * the version the copy is based on: an entry changed on one side takes that
 * side, one changed the same way on both sides is left alone, and one changed
 * differently on both sides is a conflict.
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
 * Apply a conflict-free plan: copy the remote entries over and delete the
 * removed ones. Entries the plan doesn't name keep their local state.
 */
export const applyMerge = async (
  setDir: string,
  remoteDir: string,
  plan: MergePlan,
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
};
