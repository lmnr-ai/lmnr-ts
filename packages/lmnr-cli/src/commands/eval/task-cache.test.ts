import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { packTar, type TarEntry } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheRoot,
  ensureCachedTask,
  ensureTasksDir,
  extractTaskArchive,
  installTask,
  safeEntryPath,
} from "./task-cache";
import { hashTaskDir, packTask } from "./tasks";

let root: string;

const streamOf = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

const tarGz = async (entries: TarEntry[]) =>
  streamOf(gzipSync(await packTar(entries)));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("cacheRoot", () => {
  void it("prefers LMNR_CACHE_DIR, then XDG_CACHE_HOME/lmnr, then ~/.cache/lmnr", () => {
    expect(cacheRoot({ LMNR_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x" })).toBe(
      "/c",
    );
    expect(cacheRoot({ XDG_CACHE_HOME: "/x" })).toBe(path.join("/x", "lmnr"));
    expect(cacheRoot({})).toMatch(/\.cache[/\\]lmnr$/);
  });
});

void describe("extractTaskArchive", () => {
  void it("extracts what packTask packs, exec bits included", async () => {
    const task = path.join(root, "task");
    await mkdir(path.join(task, "tests"), { recursive: true });
    await writeFile(path.join(task, "task.toml"), "[task]");
    await writeFile(path.join(task, "tests/test.sh"), "#!/bin/sh");
    await chmod(path.join(task, "tests/test.sh"), 0o755);
    const long = `${"deep/".repeat(40)}file.txt`;
    await mkdir(path.dirname(path.join(task, long)), { recursive: true });
    await writeFile(path.join(task, long), "long");

    const { archive } = await packTask(task);
    const dest = path.join(root, "out");
    await mkdir(dest);
    expect(await extractTaskArchive(streamOf(archive), dest)).toBe(
      await hashTaskDir(task),
    );

    expect(await readFile(path.join(dest, "tests/test.sh"), "utf8")).toBe(
      "#!/bin/sh",
    );
    expect((await stat(path.join(dest, "tests/test.sh"))).mode & 0o777).toBe(
      0o755,
    );
    expect((await stat(path.join(dest, "task.toml"))).mode & 0o777).toBe(0o644);
    expect(await readFile(path.join(dest, long), "utf8")).toBe("long");
    expect(await hashTaskDir(dest)).toBe(await hashTaskDir(task));
  });

  void it("rejects links, absolute paths and .. without writing outside", async () => {
    const outside = path.join(root, "outside");
    const cases: TarEntry[][] = [
      [{ header: { name: "../evil", size: 1, type: "file" }, body: "x" }],
      [{ header: { name: "a/../../evil", size: 1, type: "file" }, body: "x" }],
      [
        {
          header: { name: `${outside}/evil`, size: 1, type: "file" },
          body: "x",
        },
      ],
      [
        {
          header: { name: "link", size: 0, type: "symlink", linkname: outside },
        },
        { header: { name: "link/evil", size: 1, type: "file" }, body: "x" },
      ],
      [
        {
          header: {
            name: "hard",
            size: 0,
            type: "link",
            linkname: "/etc/passwd",
          },
        },
      ],
      [{ header: { name: "C:\\evil", size: 1, type: "file" }, body: "x" }],
    ];
    for (const entries of cases) {
      const dest = await mkdtemp(path.join(root, "dest-"));
      await expect(
        extractTaskArchive(await tarGz(entries), dest),
      ).rejects.toThrow(/Refusing to extract/);
      expect(await readdir(dest)).toEqual([]);
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(path.join(root, "evil"))).toBe(false);
  });

  void it("never writes through a link already in the destination", async () => {
    const dest = path.join(root, "dest");
    await mkdir(dest);
    await mkdir(path.join(root, "target"));
    await symlink(path.join(root, "target"), path.join(dest, "sub"));
    await writeFile(path.join(root, "victim"), "keep");
    await symlink(path.join(root, "victim"), path.join(dest, "file"));

    await expect(
      extractTaskArchive(
        await tarGz([
          { header: { name: "file", size: 1, type: "file" }, body: "x" },
        ]),
        dest,
      ),
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(path.join(root, "victim"), "utf8")).toBe("keep");
  });

  void it("checks entry paths", () => {
    expect(safeEntryPath("a/b.txt")).toBe(path.join("a", "b.txt"));
    expect(safeEntryPath("dir/")).toBe("dir");
    for (const bad of [
      "",
      "/",
      "/a",
      "a//b",
      "./a",
      "a/./b",
      "..",
      "a\\b",
      "C:x",
    ]) {
      expect(safeEntryPath(bad)).toBeNull();
    }
  });
});

void describe("extractTaskArchive's hash", () => {
  void it("comes from the archive's modes, so no OS's lack of exec bits breaks it", async () => {
    const task = path.join(root, "task");
    await mkdir(task);
    // Exec bits the Windows extension rule gets wrong both ways.
    await writeFile(path.join(task, "run"), "#!/bin/sh");
    await chmod(path.join(task, "run"), 0o755);
    await writeFile(path.join(task, "notes.sh"), "not run");
    await chmod(path.join(task, "notes.sh"), 0o644);
    const { archive } = await packTask(task);
    const dest = path.join(root, "out");
    await mkdir(dest);

    const hash = await extractTaskArchive(streamOf(archive), dest);
    expect(hash).toBe(await hashTaskDir(task, "linux"));
    expect(await hashTaskDir(dest, "win32")).not.toBe(hash);
  });
});

void describe("ensureCachedTask / installTask", () => {
  void it("downloads once, verifies the hash, and installs copies", async () => {
    const task = path.join(root, "src");
    await mkdir(path.join(task, "tests"), { recursive: true });
    await writeFile(path.join(task, "task.toml"), "[task]");
    await writeFile(path.join(task, "tests/test.sh"), "#!/bin/sh");
    await chmod(path.join(task, "tests/test.sh"), 0o755);
    const hash = await hashTaskDir(task);
    const { archive } = await packTask(task);
    const download = vi.fn(async () => streamOf(archive));
    const env = { LMNR_CACHE_DIR: path.join(root, "cache") };

    const cached = await ensureCachedTask(hash, download, env);
    expect(cached).toBe(
      path.join(root, "cache", "eval-tasks", hash.slice("sha256:".length)),
    );
    expect(await ensureCachedTask(hash, download, env)).toBe(cached);
    expect(download).toHaveBeenCalledTimes(1);
    // Only verified tasks stay: no staging dirs are left behind.
    expect(await readdir(path.join(root, "cache", "eval-tasks"))).toEqual([
      hash.slice("sha256:".length),
    ]);

    const tasks = path.join(root, "evals/s/tasks");
    await ensureTasksDir(tasks);
    await mkdir(path.join(tasks, "t"));
    await writeFile(path.join(tasks, "t/stale.txt"), "old");
    await installTask(cached, path.join(tasks, "t"));
    expect(await hashTaskDir(path.join(tasks, "t"))).toBe(hash);
    expect(await readdir(tasks)).toEqual(["t"]);

    // A link in the task's place is replaced, not followed.
    await mkdir(path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), path.join(tasks, "u"));
    await installTask(cached, path.join(tasks, "u"));
    expect((await lstat(path.join(tasks, "u"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(root, "elsewhere"))).toEqual([]);
  });

  void it("rejects a download that doesn't match its hash", async () => {
    const task = path.join(root, "src");
    await mkdir(task);
    await writeFile(path.join(task, "task.toml"), "[task]");
    const { archive } = await packTask(task);
    const wrong = `sha256:${"0".repeat(64)}`;
    const env = { LMNR_CACHE_DIR: path.join(root, "cache") };

    await expect(
      ensureCachedTask(wrong, async () => streamOf(archive), env),
    ).rejects.toThrow(/doesn't match its hash/);
    expect(await readdir(path.join(root, "cache", "eval-tasks"))).toEqual([]);
  });

  void it("refuses a tasks/ that is a link", async () => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "tasks"));
    await expect(
      ensureTasksDir(path.join(root, "tasks")),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/symlink/),
    });
  });
});
