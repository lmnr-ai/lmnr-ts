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
} from "./dataset-sync";
import { globToRegExp } from "./datasets";

const H = (c: string) => c.repeat(64);
const [H1, H2, H3, H4] = ["1", "2", "3", "4"].map(H);
const all = (_task: string) => true;
const only = (...globs: string[]) => taskFilter(globs.map(globToRegExp));

const snap = (s: Partial<DatasetSnapshot>): DatasetSnapshot => ({
  pins: {},
  local: {},
  missing: {},
  ...s,
});

const pull = (
  s: Partial<DatasetSnapshot>,
  opts: { force?: boolean; selected?: typeof all } = {},
) =>
  planPull(snap(s), {
    selected: opts.selected ?? all,
    force: !!opts.force,
  });

void describe("planPull", () => {
  void it("adds missing tasks, changes others, removes unpinned ones Laminar has", () => {
    const plan = pull({
      pins: { a: H1, b: H2, c: H3 },
      // b is at an older version, d was dropped from dataset.toml.
      local: { b: H1, c: H3, d: H4 },
    });
    expect(plan.added).toEqual([{ task: "a", hash: H1 }]);
    expect(plan.changed).toEqual([{ task: "b", from: H1, to: H2 }]);
    expect(plan.removed).toEqual([{ task: "d", hash: H4 }]);
    expect(plan.skipped).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  void it("refuses to overwrite versions Laminar doesn't have without --force", () => {
    const s = {
      pins: { a: H1, b: H2 },
      local: { a: H3, b: H4 },
      // a's local version is an unpushed edit; b's is in Laminar.
      missing: { a: H3 },
    };
    expect(pull(s).conflicts).toEqual(["a"]);
    const forced = pull(s, { force: true });
    expect(forced.conflicts).toEqual([]);
    expect(forced.changed).toEqual([
      { task: "a", from: H3, to: H1 },
      { task: "b", from: H4, to: H2 },
    ]);
  });

  void it("leaves new tasks (unpinned, not in Laminar) for push", () => {
    const plan = pull({
      pins: { a: H1 },
      local: { a: H1, n: H2 },
      missing: { n: H2 },
    });
    expect(plan.removed).toEqual([]);
    expect(plan.skipped).toEqual([{ task: "n", hash: H2, reason: "unpushed" }]);
    expect(plan.conflicts).toEqual([]);
  });

  void it("is a no-op when every task is at its pin", () => {
    const plan = pull({
      pins: { a: H1 },
      local: { a: H1 },
      missing: { a: H1 },
    });
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  void it("with nothing pinned, only removes tasks Laminar has", () => {
    const plan = pull({
      pins: null,
      local: { a: H1, b: H2 },
      missing: { b: H2 },
    });
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([{ task: "a", hash: H1 }]);
    expect(plan.skipped).toEqual([{ task: "b", hash: H2, reason: "unpushed" }]);
  });

  void it("--task limits what is added, changed and removed", () => {
    const plan = pull(
      {
        pins: { "acme/refund": H1, "acme/other": H2 },
        local: { "acme/refund-old": H3, "acme/gone": H4 },
      },
      { selected: only("refund*") },
    );
    expect(plan.added).toEqual([{ task: "acme/refund", hash: H1 }]);
    expect(plan.removed).toEqual([{ task: "acme/refund-old", hash: H3 }]);
  });
});

void describe("planPush", () => {
  void it("uploads and pins new tasks and edits Laminar doesn't have", () => {
    const plan = planPush(
      snap({
        pins: { a: H1, b: H2 },
        local: { a: H3, b: H2, n: H4 },
        missing: { a: H3, n: H4 },
      }),
    );
    expect(plan.added).toEqual([{ task: "n", hash: H4 }]);
    expect(plan.changed).toEqual([{ task: "a", from: H1, to: H3 }]);
    expect(plan.skipped).toEqual([]);
    expect(plan.pins).toEqual({ a: H3, b: H2, n: H4 });
  });

  void it("is a no-op when every task is at its pin", () => {
    const plan = planPush(snap({ pins: { a: H1 }, local: { a: H1 } }));
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  void it("skips versions Laminar has under another pin, or none", () => {
    const plan = planPush(
      snap({
        // a: an older (or newer) version; d: dropped from dataset.toml.
        pins: { a: H1 },
        local: { a: H2, d: H3 },
      }),
    );
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(plan.skipped).toEqual([
      { task: "a", hash: H2, reason: "outdated" },
      { task: "d", hash: H3, reason: "unpinned" },
    ]);
    expect(plan.pins).toEqual({ a: H1 });
  });

  void it("keeps the pins of tasks with no local dir", () => {
    const plan = planPush(
      snap({ pins: { a: H1, b: H2 }, local: { a: H3 }, missing: { a: H3 } }),
    );
    expect(plan.pins).toEqual({ a: H3, b: H2 });
  });

  void it("pins every task of a dataset Laminar doesn't have", () => {
    const plan = planPush(
      snap({ pins: null, local: { a: H1, b: H2 }, missing: { a: H1, b: H2 } }),
    );
    expect(plan.added).toEqual([
      { task: "a", hash: H1 },
      { task: "b", hash: H2 },
    ]);
    expect(plan.pins).toEqual({ a: H1, b: H2 });
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
