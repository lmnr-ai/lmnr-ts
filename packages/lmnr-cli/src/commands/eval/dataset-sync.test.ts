import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { packTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { taskFilter } from "./dataset-state";
import {
  type DatasetSnapshot,
  extractVersion,
  planPull,
  planPush,
  planRunPull,
} from "./dataset-sync";
import { globToRegExp } from "./datasets";

const H = (c: string) => c.repeat(64);
const [H1, H2, H3, H4] = ["1", "2", "3", "4"].map(H);
const all = (_task: string) => true;
const only = (...globs: string[]) => taskFilter(globs.map(globToRegExp));

const snap = (s: Partial<DatasetSnapshot>): DatasetSnapshot => ({
  pins: {},
  state: {},
  local: {},
  latest: {},
  ...s,
});

const pull = (
  s: Partial<DatasetSnapshot>,
  opts: { force?: boolean; latest?: boolean; selected?: typeof all } = {},
) =>
  planPull(snap(s), {
    selected: opts.selected ?? all,
    force: !!opts.force,
    latest: !!opts.latest,
  });

void describe("planPull", () => {
  void it("adds missing tasks, changes unedited ones, removes unpinned ones", () => {
    const plan = pull({
      pins: { a: H1, b: H2, c: H3 },
      // b was pulled at H1 and not edited; d was pulled before, unpinned now.
      state: { b: H1, c: H3, d: H4 },
      local: { b: H1, c: H3, d: H4 },
    });
    expect(plan.added).toEqual([{ task: "a", hash: H1 }]);
    expect(plan.changed).toEqual([{ task: "b", from: H1, to: H2 }]);
    expect(plan.removed).toEqual([{ task: "d", hash: H4 }]);
    expect(plan.edited).toEqual([]);
    expect(plan.state).toEqual({ a: H1, b: H2, c: H3 });
    expect(plan.writePins).toBe(false);
  });

  void it("refuses to overwrite or remove edited tasks without --force", () => {
    const s = {
      pins: { a: H1, b: H2 },
      // a: edited (local differs from base); b: local dir never pulled here;
      // c: pulled, edited, then unpinned.
      state: { a: H1, c: H3 },
      local: { a: H4, b: H3, c: H4 },
    };
    expect(pull(s).edited).toEqual(["a", "b", "c"]);
    const forced = pull(s, { force: true });
    expect(forced.edited).toEqual([]);
    expect(forced.changed.map((c) => c.task)).toEqual(["a", "b"]);
    expect(forced.removed).toEqual([{ task: "c", hash: H4 }]);
  });

  void it("leaves a task already at its target alone, updating its base", () => {
    const plan = pull({
      pins: { a: H2 },
      state: { a: H1 },
      local: { a: H2 },
    });
    expect([plan.added, plan.changed, plan.edited]).toEqual([[], [], []]);
    expect(plan.state).toEqual({ a: H2 });
  });

  void it("drops the base of a task whose dir is gone and pin removed", () => {
    const plan = pull({ pins: {}, state: { gone: H1 }, local: {} });
    expect(plan.removed).toEqual([]);
    expect(plan.state).toEqual({});
  });

  void it("never touches local tasks that were not pulled here", () => {
    const plan = pull({ pins: { a: H1 }, state: {}, local: { mine: H2 } });
    expect(plan.removed).toEqual([]);
    expect(plan.added).toEqual([{ task: "a", hash: H1 }]);
  });

  void it("with --latest pins Laminar's latest, keeping unselected pins", () => {
    const plan = pull(
      {
        pins: { a: H1, b: H1, c: H1 },
        state: { a: H1, b: H1 },
        local: { a: H1, b: H1 },
        latest: { a: H2, b: H3, c: H4, d: H4 },
      },
      { latest: true, selected: only("a", "d") },
    );
    expect(plan.changed).toEqual([{ task: "a", from: H1, to: H2 }]);
    expect(plan.added).toEqual([{ task: "d", hash: H4 }]);
    expect(plan.pins).toEqual({ a: H2, b: H1, c: H1, d: H4 });
    expect(plan.writePins).toBe(true);
    expect(plan.state).toEqual({ a: H2, b: H1, d: H4 });
  });

  void it("pulls the latest when dataset.toml pins nothing", () => {
    const plan = pull({ pins: null, latest: { a: H1, b: H2 } });
    expect(plan.added.map((t) => t.task)).toEqual(["a", "b"]);
    expect(plan.pins).toEqual({ a: H1, b: H2 });
    expect(plan.writePins).toBe(true);
  });

  void it("--task limits changes and removals", () => {
    const plan = pull(
      {
        pins: { a: H2, b: H2 },
        state: { a: H1, b: H1, c: H1 },
        local: { a: H1 },
      },
      { selected: only("a") },
    );
    expect(plan.changed).toEqual([{ task: "a", from: H1, to: H2 }]);
    expect(plan.removed).toEqual([]);
    expect(plan.state).toEqual({ a: H2, b: H1, c: H1 });
  });
});

void describe("planPush", () => {
  void it("adds new tasks and changes edited ones, based on Laminar's latest", () => {
    const plan = planPush(
      snap({
        pins: { a: H1, b: H1 },
        state: { a: H1, b: H1 },
        local: { a: H1, b: H2, c: H3 },
        latest: { a: H1, b: H1 },
      }),
      all,
    );
    expect(plan.moved).toEqual([]);
    expect(plan.added).toEqual([{ task: "c", hash: H3, base: null }]);
    expect(plan.changed).toEqual([{ task: "b", hash: H2, base: H1, from: H1 }]);
    expect(plan.pins).toEqual({ a: H1, b: H2, c: H3 });
    expect(plan.state).toEqual({ a: H1, b: H2, c: H3 });
    expect(plan.writePins).toBe(true);
  });

  void it("is a no-op when everything is pushed and pinned", () => {
    const plan = planPush(
      snap({
        pins: { a: H1 },
        state: { a: H1 },
        local: { a: H1 },
        latest: { a: H1 },
      }),
      all,
    );
    expect([plan.added, plan.changed, plan.removed]).toEqual([[], [], []]);
    expect(plan.writePins).toBe(false);
  });

  void it("refuses tasks whose pin moved in Laminar, edited or not", () => {
    const plan = planPush(
      snap({
        pins: { a: H1, b: H1 },
        state: { a: H1, b: H1 },
        local: { a: H1, b: H4 },
        latest: { a: H2, b: H3 },
      }),
      all,
    );
    expect(plan.moved).toEqual([
      { task: "a", where: "laminar", to: H2 },
      { task: "b", where: "laminar", to: H3 },
    ]);
  });

  void it("refuses tasks whose dataset.toml pin moved without a pull here", () => {
    const plan = planPush(
      snap({
        pins: { a: H2 },
        state: { a: H1 },
        local: { a: H1 },
        latest: { a: H1 },
      }),
      all,
    );
    expect(plan.moved).toEqual([{ task: "a", where: "pin", to: H2 }]);
  });

  void it("refuses a task created elsewhere with other content", () => {
    const moved = planPush(
      snap({ pins: null, local: { a: H1 }, latest: { a: H2 } }),
      all,
    );
    expect(moved.moved).toEqual([{ task: "a", where: "laminar", to: H2 }]);
    // Same content as Laminar's latest: just pinned, based on it.
    const same = planPush(
      snap({ pins: null, local: { a: H1 }, latest: { a: H1 } }),
      all,
    );
    expect(same.moved).toEqual([]);
    expect(same.added).toEqual([{ task: "a", hash: H1, base: H1 }]);
    expect(same.writePins).toBe(true);
  });

  void it("reverts a task to an older hash", () => {
    // Pulled at H2 (latest), then the dir was restored to the older H1.
    const plan = planPush(
      snap({
        pins: { a: H2 },
        state: { a: H2 },
        local: { a: H1 },
        latest: { a: H2 },
      }),
      all,
    );
    expect(plan.changed).toEqual([{ task: "a", hash: H1, base: H2, from: H2 }]);
    expect(plan.pins).toEqual({ a: H1 });
  });

  void it("unpins tasks pulled here whose dir is gone, nothing else", () => {
    // `pull --task a` then push: b and c were never pulled here.
    const plan = planPush(
      snap({
        pins: { a: H1, b: H1, c: H1, gone: H1 },
        state: { a: H1, gone: H1 },
        local: { a: H1 },
        latest: { a: H1, b: H1, c: H1, gone: H1 },
      }),
      all,
    );
    expect(plan.removed).toEqual([{ task: "gone", hash: H1 }]);
    expect(plan.pins).toEqual({ a: H1, b: H1, c: H1 });
    expect(plan.state).toEqual({ a: H1 });
  });

  void it("--task limits what is pushed and unpinned", () => {
    const plan = planPush(
      snap({
        pins: { a: H1, gone: H1 },
        state: { a: H1, gone: H1 },
        local: { a: H2 },
        latest: { a: H1 },
      }),
      only("a"),
    );
    expect(plan.changed.map((c) => c.task)).toEqual(["a"]);
    expect(plan.removed).toEqual([]);
  });

  void it("pushes against a dataset Laminar doesn't have", () => {
    const plan = planPush(
      snap({
        pins: { a: H1 },
        state: { a: H1 },
        local: { a: H1 },
        latest: null,
      }),
      all,
    );
    expect(plan.changed).toEqual([
      { task: "a", hash: H1, base: null, from: H1 },
    ]);
  });
});

void describe("planRunPull", () => {
  void it("pulls missing and unedited re-pinned tasks; edited ones run as they are", () => {
    const plan = planRunPull(
      {
        pins: { missing: H1, same: H1, repinned: H2, edited: H2, mine: H2 },
        state: { same: H1, repinned: H1, edited: H1 },
        local: { same: H1, repinned: H1, edited: H3, mine: H3 },
      },
      all,
    );
    expect(plan.pull).toEqual([
      { task: "missing", hash: H1 },
      { task: "repinned", hash: H2 },
    ]);
    expect(plan.edited).toEqual([
      { task: "edited", hash: H2 },
      { task: "mine", hash: H2 },
    ]);
    expect(
      planRunPull({ pins: { a: H1, b: H1 }, state: {}, local: {} }, only("b"))
        .pull,
    ).toEqual([{ task: "b", hash: H1 }]);
  });
});

void describe("extractVersion", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lmnr-extract-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const archive = async (
    entries: { name: string; type?: "file" | "symlink"; linkname?: string }[],
  ) =>
    gzipSync(
      await packTar(
        entries.map(({ name, type = "file", linkname }) => ({
          header: { name, type, linkname, size: type === "file" ? 1 : 0 },
          body: type === "file" ? "x" : undefined,
        })),
      ),
    );

  void it("sets modes by the exec bit", async () => {
    const tar = gzipSync(
      await packTar([
        { header: { name: "run.py", size: 1, mode: 0o775 }, body: "x" },
        { header: { name: "./dir/a.txt", size: 1, mode: 0o664 }, body: "x" },
      ]),
    );
    const out = path.join(root, "out");
    await extractVersion(Readable.from([tar]), out);
    expect((await stat(path.join(out, "run.py"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(out, "dir/a.txt"))).mode & 0o777).toBe(0o644);
  });

  void it("skips links and rejects paths escaping the target dir", async () => {
    const out = path.join(root, "out");
    await extractVersion(
      Readable.from([
        await archive([
          { name: "ok.txt" },
          { name: "link", type: "symlink", linkname: "/etc/passwd" },
        ]),
      ]),
      out,
    );
    expect(await readdir(out)).toEqual(["ok.txt"]);

    await expect(
      extractVersion(
        Readable.from([await archive([{ name: "../escape.txt" }])]),
        path.join(root, "out2"),
      ),
    ).rejects.toThrow(/outside/);
    expect(await readdir(root)).not.toContain("escape.txt");
  });
});
