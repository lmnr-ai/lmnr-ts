import { describe, expect, it } from "vitest";

import {
  datasetStatus,
  decideRunSync,
  groupName,
  hasLocalChanges,
  isBehindLock,
} from "./sync";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const v1 = { dataset: "support", version: 1, tasks: { a: h("1"), b: h("1") } };
const v2 = { dataset: "support", version: 2, tasks: { a: h("2"), b: h("1") } };

void describe("decideRunSync", () => {
  void it("runs unversioned without a lockfile", () => {
    expect(decideRunSync(null, null, { a: h("1") })).toEqual({
      kind: "unversioned",
      reason: "not_pushed",
    });
  });

  void it("runs the lockfile's version when tasks/ matches it", () => {
    expect(decideRunSync(v2, v1, { ...v2.tasks })).toEqual({
      kind: "versioned",
      lock: v2,
    });
    expect(decideRunSync(v2, null, { ...v2.tasks }).kind).toBe("versioned");
  });

  void it("pulls into a missing or empty tasks/", () => {
    expect(decideRunSync(v2, null, {})).toEqual({ kind: "pull", lock: v2 });
    expect(decideRunSync(v2, v1, {}).kind).toBe("pull");
  });

  void it("pulls when tasks/ is unchanged since an older sync", () => {
    expect(decideRunSync(v2, v1, { ...v1.tasks })).toEqual({
      kind: "pull",
      lock: v2,
    });
  });

  void it("runs local edits unversioned, with what changed", () => {
    const edited = { a: h("3"), c: h("1") };
    expect(decideRunSync(v2, v2, edited)).toEqual({
      kind: "unversioned",
      reason: "modified",
      lock: v2,
      diff: { added: ["c"], modified: ["a"], removed: ["b"] },
    });
    // Never synced here: tasks/ that isn't the lockfile's counts as edited.
    expect(decideRunSync(v2, null, { ...v1.tasks }).kind).toBe("unversioned");
    // Edited on top of an older sync: still edits, never overwritten.
    expect(decideRunSync(v2, v1, edited).kind).toBe("unversioned");
  });
});

void describe("hasLocalChanges", () => {
  void it("compares with the last sync, or the lockfile and target", () => {
    expect(hasLocalChanges({}, null, v1, v2.tasks)).toBe(false);
    expect(hasLocalChanges({ ...v1.tasks }, v1, v1, v2.tasks)).toBe(false);
    expect(hasLocalChanges({ a: h("9") }, v1, v1, v2.tasks)).toBe(true);
    // Never synced: matching the lockfile or the target loses nothing.
    expect(hasLocalChanges({ ...v1.tasks }, null, v1, v2.tasks)).toBe(false);
    expect(hasLocalChanges({ ...v2.tasks }, null, null, v2.tasks)).toBe(false);
    expect(hasLocalChanges({ ...v1.tasks }, null, null, v2.tasks)).toBe(true);
  });

  void it("knows when tasks/ is older than the lockfile", () => {
    expect(isBehindLock(v1, v2)).toBe(true);
    expect(isBehindLock(v2, v2)).toBe(false);
    expect(isBehindLock(null, v2)).toBe(false);
    expect(isBehindLock(v1, null)).toBe(false);
  });
});

void describe("groupName", () => {
  void it("names a run's evaluation group by dataset version", () => {
    expect(groupName("support", 7)).toBe("support v7");
    expect(groupName("support", null)).toBe("support unversioned");
  });
});

void describe("datasetStatus", () => {
  void it("reports the state and the diff against the lockfile", () => {
    expect(datasetStatus("support", v2, v2, { ...v2.tasks })).toEqual({
      dataset: "support",
      path: "support",
      version: 2,
      syncedVersion: 2,
      state: "up_to_date",
      tasks: 2,
      added: [],
      modified: [],
      removed: [],
    });
    expect(datasetStatus("support", v2, v1, { ...v1.tasks })).toMatchObject({
      state: "behind",
      syncedVersion: 1,
      modified: ["a"],
    });
    expect(
      datasetStatus("support", v2, v2, { ...v2.tasks, c: h("c") }),
    ).toMatchObject({ state: "modified", added: ["c"] });
    expect(datasetStatus("new", null, null, { a: h("a") })).toMatchObject({
      dataset: "new",
      version: null,
      state: "not_pushed",
      added: ["a"],
    });
  });
});
