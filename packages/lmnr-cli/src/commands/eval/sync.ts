/**
 * How a dataset's `tasks/` relates to its lockfile and its sync state (what
 * `tasks/` was last pulled or pushed as). Pure: callers hash and read files.
 */
import {
  type DatasetLock,
  diffTasks,
  sameTasks,
  type TaskDiff,
} from "./lockfile";
import type { TaskHashes } from "./tasks";

/** What `eval run` does with a dataset before running it. */
export type RunSync =
  /** Run `tasks/` as is, as `<dataset> v<N>`. */
  | { kind: "versioned"; lock: DatasetLock }
  /** `tasks/` is missing, empty or unchanged since an older sync: pull the lockfile's version, then run it. */
  | { kind: "pull"; lock: DatasetLock }
  /** Run `tasks/` as is, as `<dataset> unversioned`: never pushed, or edited. */
  | { kind: "unversioned"; reason: "not_pushed" }
  | {
      kind: "unversioned";
      reason: "modified";
      lock: DatasetLock;
      diff: TaskDiff;
    };

const isEmpty = (tasks: TaskHashes) => Object.keys(tasks).length === 0;

export const decideRunSync = (
  lock: DatasetLock | null,
  state: DatasetLock | null,
  local: TaskHashes,
): RunSync => {
  if (!lock) return { kind: "unversioned", reason: "not_pushed" };
  if (sameTasks(local, lock.tasks)) return { kind: "versioned", lock };
  if (isEmpty(local) || (state && sameTasks(local, state.tasks))) {
    return { kind: "pull", lock };
  }
  return {
    kind: "unversioned",
    reason: "modified",
    lock,
    diff: diffTasks(lock.tasks, local),
  };
};

/**
 * Whether making `tasks/` match `target` would lose local work: `tasks/`
 * changed since the last sync, or, never synced here, matches neither the
 * lockfile nor `target`. An empty `tasks/` has nothing to lose.
 */
export const hasLocalChanges = (
  local: TaskHashes,
  state: DatasetLock | null,
  lock: DatasetLock | null,
  target: TaskHashes,
): boolean => {
  if (isEmpty(local)) return false;
  if (state) return !sameTasks(local, state.tasks);
  return !(lock && sameTasks(local, lock.tasks)) && !sameTasks(local, target);
};

/**
 * `eval push` would build on a version `tasks/` doesn't hold: it was synced to
 * other tasks than the lockfile pins (someone pushed and the lockfile came in
 * through git). Pushing would drop their changes.
 */
export const isBehindLock = (
  state: DatasetLock | null,
  lock: DatasetLock | null,
): boolean => !!state && !!lock && !sameTasks(state.tasks, lock.tasks);

/** The evaluation group a run reports to. */
export const groupName = (dataset: string, version: number | null) =>
  version === null ? `${dataset} unversioned` : `${dataset} v${version}`;

export type SyncState = "up_to_date" | "modified" | "behind" | "not_pushed";

/** `eval status` for one dataset. */
export interface DatasetStatus extends TaskDiff {
  /** The dataset's name in Laminar (the lockfile's, else the folder's). */
  dataset: string;
  /** The dataset folder, relative to the evals folder. */
  path: string;
  /** The lockfile's version; null before the first push or pull. */
  version: number | null;
  /** The version `tasks/` was last pulled or pushed as, if known. */
  syncedVersion: number | null;
  /**
   * `up_to_date`: `tasks/` matches the lockfile. `behind`: it doesn't, but
   * has no local changes (`eval pull` or `eval run` updates it). `modified`:
   * local changes. `not_pushed`: no lockfile yet.
   */
  state: SyncState;
  /** Task count in `tasks/`. */
  tasks: number;
}

/** `added` / `modified` / `removed` are `tasks/` compared with the lockfile. */
export const datasetStatus = (
  folder: string,
  lock: DatasetLock | null,
  state: DatasetLock | null,
  local: TaskHashes,
): DatasetStatus => {
  const decision = decideRunSync(lock, state, local);
  const stateName: Record<string, SyncState> = {
    versioned: "up_to_date",
    pull: "behind",
  };
  return {
    dataset: lock?.dataset ?? folder,
    path: folder,
    version: lock?.version ?? null,
    syncedVersion: state?.version ?? null,
    state:
      decision.kind === "unversioned"
        ? decision.reason
        : stateName[decision.kind],
    tasks: Object.keys(local).length,
    ...diffTasks(lock?.tasks ?? {}, local),
  };
};
