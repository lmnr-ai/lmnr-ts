import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { unpackTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashLocalTasks,
  hashTaskDir,
  isValidName,
  listTasks,
  MAX_DATASET_NAME,
  packTask,
  walkTaskFiles,
} from "./tasks";

let root: string;

const write = async (rel: string, content = "x", mode?: number) => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (mode !== undefined) await chmod(file, mode);
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-tasks-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("task hash", () => {
  void it("hashes one `<mode> <sha256> <path>` line per file, as specified", async () => {
    await write("t/task.toml", "[task]\n", 0o644);
    await write("t/tests/test.sh", "#!/bin/sh\n", 0o755);

    const expected = sha(
      `644 ${sha("[task]\n")} task.toml\n` +
        `755 ${sha("#!/bin/sh\n")} tests/test.sh\n`,
    );
    expect(await hashTaskDir(path.join(root, "t"), "linux")).toBe(expected);
    // An empty task hashes the empty listing.
    await mkdir(path.join(root, "empty"));
    expect(await hashTaskDir(path.join(root, "empty"), "linux")).toBe(sha(""));
  });

  void it("sorts paths by UTF-8 bytes, whatever order files were written in", async () => {
    // U+FF61 sorts before U+1F600 in UTF-8 but after it in UTF-16.
    const names = ["b.txt", "a/b", "a.txt", "B", "｡.txt", "\u{1f600}.txt"];
    for (const name of names) await write(`one/${name}`, name);
    for (const name of [...names].reverse()) await write(`two/${name}`, name);

    const files = await walkTaskFiles(path.join(root, "one"), "linux");
    expect(files.map((f) => f.target)).toEqual([
      "B",
      "a.txt",
      "a/b",
      "b.txt",
      "｡.txt",
      "\u{1f600}.txt",
    ]);
    expect(await hashTaskDir(path.join(root, "one"), "linux")).toBe(
      await hashTaskDir(path.join(root, "two"), "linux"),
    );
  });

  void it("only tells executable from not: any execute bit is 755", async () => {
    await write("a/run", "x", 0o700);
    await write("b/run", "x", 0o755);
    await write("c/run", "x", 0o600);
    await write("d/run", "x", 0o644);
    const hash = (dir: string) => hashTaskDir(path.join(root, dir), "linux");

    expect(await hash("a")).toBe(await hash("b"));
    expect(await hash("c")).toBe(await hash("d"));
    expect(await hash("a")).not.toBe(await hash("c"));
  });

  void it("uses Harbor's .sh rule on Windows, which has no execute bits", async () => {
    await write("w/tests/test.sh", "#!/bin/sh", 0o644);
    await write("w/run", "x", 0o755);
    const files = await walkTaskFiles(path.join(root, "w"), "win32");
    expect(files.map((f) => [f.target, f.mode])).toEqual([
      ["run", 0o644],
      ["tests/test.sh", 0o755],
    ]);
  });

  void it("skips env files, cached dirs, symlinks and the sync state", async () => {
    await write("clean/task.toml");
    await write("dirty/task.toml");
    await write("dirty/.env", "SECRET=1");
    await write("dirty/environment/.env.local", "SECRET=1");
    await write("dirty/.DS_Store");
    await write("dirty/.lmnr-state.json", "{}");
    await write("dirty/node_modules/x/index.js");
    await write("dirty/tests/__pycache__/t.pyc");
    await write("dirty/jobs/old/result.json");
    await symlink("/etc/passwd", path.join(root, "dirty/passwd"));

    expect(await hashTaskDir(path.join(root, "dirty"))).toBe(
      await hashTaskDir(path.join(root, "clean")),
    );
  });

  void it("changes when a file's content, path or mode changes", async () => {
    await write("t/task.toml", "a");
    const before = await hashTaskDir(path.join(root, "t"), "linux");
    await write("t/task.toml", "b");
    const content = await hashTaskDir(path.join(root, "t"), "linux");
    await chmod(path.join(root, "t/task.toml"), 0o755);
    const mode = await hashTaskDir(path.join(root, "t"), "linux");
    expect(new Set([before, content, mode]).size).toBe(3);
  });
});

void describe("listTasks", () => {
  void it("lists task dirs only: no files, hidden or cached dirs, or links", async () => {
    await write("s/tasks/alpha/task.toml");
    await write("s/tasks/beta/task.toml");
    await write("s/tasks/.lmnr-state.json", "{}");
    await write("s/tasks/README.md");
    await write("s/tasks/.beta.lmnr-tmp-1234/task.toml");
    await write("s/tasks/__pycache__/x.pyc");
    await symlink(
      path.join(root, "s/tasks/alpha"),
      path.join(root, "s/tasks/linked"),
    );

    const local = await listTasks(path.join(root, "s"));
    expect(local.exists).toBe(true);
    expect(Object.keys(local.dirs).sort()).toEqual(["alpha", "beta"]);
    expect(local.symlinks).toEqual(["linked"]);
    const hashes = await hashLocalTasks(local);
    expect(Object.keys(hashes)).toEqual(["alpha", "beta"]);
    expect(hashes.alpha).toBe(hashes.beta);

    expect(await listTasks(path.join(root, "none"))).toEqual({
      exists: false,
      dirs: {},
      symlinks: [],
    });
  });

  void it("validates names like the server", () => {
    for (const ok of ["support", "a", "A.b_c-1", "9lives"]) {
      expect(isValidName(ok, MAX_DATASET_NAME)).toBe(true);
    }
    for (const bad of ["", ".hidden", "-x", "a b", "a/b", "..", "é"]) {
      expect(isValidName(bad, MAX_DATASET_NAME)).toBe(false);
    }
    expect(isValidName("a".repeat(101), MAX_DATASET_NAME)).toBe(false);
  });
});

void describe("packTask", () => {
  void it("packs the hashed files relative to the task dir, modes normalized", async () => {
    await write("t/task.toml", "[task]");
    await write("t/tests/test.sh", "#!/bin/sh", 0o700);
    await write("t/.env", "SECRET=1");

    const { archive, index } = await packTask(path.join(root, "t"), "linux");
    const entries = (await unpackTar(gunzipSync(archive))).filter(
      (e) => e.header.type === "file",
    );
    expect(entries.map((e) => [e.header.name, e.header.mode])).toEqual([
      ["task.toml", 0o644],
      ["tests/test.sh", 0o755],
    ]);
    expect(index.map((f) => f.path)).toEqual(["task.toml", "tests/test.sh"]);
  });
});
