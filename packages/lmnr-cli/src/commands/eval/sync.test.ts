import { describe, expect, it } from "vitest";

import { taskScope } from "./datasets";
import { canonicalHashes, planPull, planPush } from "./sync";

const h = (c: string) => c.repeat(64);
const all = taskScope(undefined);
const state = (tasks: Record<string, string>, localHashes = {}) => ({
  tasks,
  localHashes,
});

void describe("planPull", () => {
  void it("adds, changes, removes synced tasks, and keeps new local ones", () => {
    const disk = { same: h("1"), old: h("2"), gone: h("3"), mine: h("4") };
    const synced = state({ same: h("1"), old: h("2"), gone: h("3") });
    const target = { same: h("1"), old: h("9"), fresh: h("5") };
    expect(planPull(disk, synced, target, all)).toEqual({
      added: ["fresh"],
      changed: ["old"],
      removed: ["gone"],
      unchanged: ["same"],
      conflicts: [],
    });
  });

  void it("flags edited tasks it would change or remove", () => {
    const disk = { edited: h("e"), cut: h("f"), unsynced: h("u"), ok: h("1") };
    const synced = state({ edited: h("1"), cut: h("2"), ok: h("1") });
    const target = { edited: h("1"), unsynced: h("9"), ok: h("1") };
    expect(planPull(disk, synced, target, all)).toMatchObject({
      changed: ["edited", "unsynced"],
      removed: ["cut"],
      conflicts: ["cut", "edited", "unsynced"],
    });
    // An edited task that already matches the target loses nothing.
    expect(
      planPull({ a: h("1") }, state({}), { a: h("1") }, all).conflicts,
    ).toEqual([]);
  });

  void it("removes only within --task", () => {
    const disk = { "refund-a": h("1"), other: h("2") };
    const synced = state(disk);
    expect(planPull(disk, synced, {}, taskScope(["refund-*"])).removed).toEqual(
      ["refund-a"],
    );
  });
});

void describe("planPush", () => {
  void it("compares tasks/ with tasks.toml", () => {
    const disk = { same: h("1"), edited: h("e"), fresh: h("3") };
    const synced = state({ same: h("1"), edited: h("2"), gone: h("4") });
    const toml = { same: h("1"), edited: h("2"), gone: h("4"), never: h("5") };
    expect(planPush(disk, synced, toml, all)).toEqual({
      added: ["fresh"],
      changed: ["edited"],
      // `never` was never pulled here: it stays pinned.
      removed: ["gone"],
      unchanged: ["same"],
      behind: [],
    });
  });

  void it("finds unedited tasks whose pin moved since the sync", () => {
    const disk = { a: h("1"), b: h("1"), c: h("e") };
    const synced = state({ a: h("1"), b: h("1"), c: h("1") });
    const toml = { a: h("2"), c: h("2") };
    // a: pin moved; b: pin dropped; c: edited, so it's the user's version.
    expect(planPush(disk, synced, toml, all).behind).toEqual(["a", "b"]);
    expect(planPush(disk, synced, toml, taskScope(["c"])).behind).toEqual([]);
  });
});

void describe("canonicalHashes", () => {
  void it("maps a task still on its synced disk hash to the shared hash", () => {
    const synced = state({ a: h("a"), b: h("1") }, { a: h("w") });
    expect(canonicalHashes({ a: h("w"), b: h("1") }, synced)).toEqual(
      synced.tasks,
    );
    // Edited since the sync: its disk hash stands.
    expect(canonicalHashes({ a: h("e"), b: h("1") }, synced)).toEqual({
      a: h("e"),
      b: h("1"),
    });
    expect(canonicalHashes({ a: h("w") }, state({}))).toEqual({ a: h("w") });
  });
});
