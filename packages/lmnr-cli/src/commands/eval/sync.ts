/**
 * How a dataset's `tasks/` relates to its `tasks.toml` and its sync state
 * (what each task was last pulled or pushed as). Pure: callers hash and read
 * files. Every decision is per task.
 */

import { byteOrder, type TaskHashes } from "./tasks";
import type { SyncState } from "./tasks-toml";

const sorted = (names: Iterable<string>) => [...names].sort(byteOrder);

/**
 * `tasks/`' hashes as every other machine computes them: a task still hashing
 * to its `localHashes` entry is unchanged since the sync, so it counts as the
 * synced hash. Elsewhere disk hashes are already the shared ones.
 */
export const canonicalHashes = (
  disk: TaskHashes,
  state: SyncState,
): TaskHashes =>
  Object.fromEntries(
    Object.entries(disk).map(([name, hash]) => [
      name,
      state.localHashes[name] === hash ? state.tasks[name] : hash,
    ]),
  );

/** A task in `tasks/` changed since its last sync, or was never synced here. */
export const isEdited = (name: string, hashes: TaskHashes, state: SyncState) =>
  name in hashes && state.tasks[name] !== hashes[name];

/** Whether `--task` globs (none: every task) take this task. */
export type TaskScope = (name: string) => boolean;

export const pickTasks = (tasks: TaskHashes, scope: TaskScope): TaskHashes =>
  Object.fromEntries(Object.entries(tasks).filter(([name]) => scope(name)));

export interface PullPlan {
  /** In the target, not in `tasks/`: downloaded. */
  added: string[];
  /** In `tasks/` with another hash than the target: replaced. */
  changed: string[];
  /** In `tasks/` and the sync state, not in the target: deleted. */
  removed: string[];
  /** Already the target's version. */
  unchanged: string[];
  /** Changed or removed tasks with local edits: the pull would lose them. */
  conflicts: string[];
}

/**
 * Make the tasks in `scope` match `target` (the pinned hashes, already
 * picked by scope). A task in `tasks/` that was never synced and isn't in
 * the target is a new local task: it stays.
 */
export const planPull = (
  hashes: TaskHashes,
  state: SyncState,
  target: TaskHashes,
  scope: TaskScope,
): PullPlan => {
  const names = Object.keys(target);
  const changed = sorted(
    names.filter((n) => n in hashes && hashes[n] !== target[n]),
  );
  const removed = sorted(
    Object.keys(hashes).filter(
      (n) => scope(n) && !(n in target) && n in state.tasks,
    ),
  );
  return {
    added: sorted(names.filter((n) => !(n in hashes))),
    changed,
    removed,
    unchanged: sorted(names.filter((n) => hashes[n] === target[n])),
    conflicts: sorted(
      [...changed, ...removed].filter((n) => isEdited(n, hashes, state)),
    ),
  };
};

export interface PushPlan {
  /** In `tasks/`, not in `tasks.toml`. */
  added: string[];
  /** In `tasks/` with another hash than `tasks.toml` pins. */
  changed: string[];
  /** Pinned, synced here, and deleted from `tasks/`: dropped from `tasks.toml`. */
  removed: string[];
  unchanged: string[];
  /**
   * Unedited tasks whose pin moved since they were synced here (`tasks.toml`
   * came in through git): pushing them would undo that newer version.
   */
  behind: string[];
}

/**
 * Compare the tasks in `scope` with `tasks.toml`. A pinned task that is
 * neither in `tasks/` nor in the sync state was never pulled here, so it
 * stays pinned rather than counting as removed.
 */
export const planPush = (
  hashes: TaskHashes,
  state: SyncState,
  toml: TaskHashes,
  scope: TaskScope,
): PushPlan => {
  const local = Object.keys(hashes).filter(scope);
  const behind = local.filter(
    (n) => !isEdited(n, hashes, state) && toml[n] !== state.tasks[n],
  );
  return {
    added: sorted(local.filter((n) => !(n in toml))),
    changed: sorted(local.filter((n) => n in toml && toml[n] !== hashes[n])),
    removed: sorted(
      Object.keys(toml).filter(
        (n) => scope(n) && !(n in hashes) && n in state.tasks,
      ),
    ),
    unchanged: sorted(local.filter((n) => toml[n] === hashes[n])),
    behind: sorted(behind),
  };
};
