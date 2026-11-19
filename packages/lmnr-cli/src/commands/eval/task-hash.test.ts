import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { unpackTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractVersion } from "./dataset-sync";
import { hashTaskDir, packTaskDir } from "./task-hash";

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** A tiny task; its hash below was computed independently of this code. */
const writeFixture = async () => {
  await write("task/task.toml", "[task]\n");
  await write("task/tests/test.sh", "#!/bin/sh\nexit 0\n");
  await chmod(path.join(root, "task/tests/test.sh"), 0o755);
  // Bytewise order: `a-b.txt` ('-' is 0x2d) sorts before `a/b.txt` ('/' 0x2f).
  await write("task/a-b.txt", "x");
  await write("task/a/b.txt", "y");
};
const FIXTURE_HASH =
  "c722f890865670bbb651d31e667b9a7ee8f19b0cb5a94395bafeb87b35619ad8";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-hash-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("hashTaskDir", () => {
  void it("hashes modes, contents and paths in bytewise order", async () => {
    await writeFixture();
    expect(await hashTaskDir(path.join(root, "task"), "linux")).toBe(
      FIXTURE_HASH,
    );
    // An empty task hashes the empty string.
    await mkdir(path.join(root, "empty"));
    expect(await hashTaskDir(path.join(root, "empty"))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  void it("leaves out env files, .DS_Store, skipped dirs and symlinks", async () => {
    await writeFixture();
    await write("task/.env", "SECRET=1");
    await write("task/.envrc", "export A=1");
    await write("task/a/.env.local", "SECRET=1");
    await write("task/.DS_Store");
    await write("task/node_modules/pkg/index.js");
    await write("task/.git/config");
    await write("task/jobs/2026/result.json");
    await write("task/a/__pycache__/x.pyc");
    await symlink("task.toml", path.join(root, "task/link.toml"));
    await symlink(path.join(root, "task/a"), path.join(root, "task/linked"));

    expect(await hashTaskDir(path.join(root, "task"), "linux")).toBe(
      FIXTURE_HASH,
    );
  });

  void it("counts any exec bit as 755, and .sh files on Windows", async () => {
    await writeFixture();
    const script = path.join(root, "task/tests/test.sh");
    await chmod(script, 0o700);
    expect(await hashTaskDir(path.join(root, "task"), "linux")).toBe(
      FIXTURE_HASH,
    );
    await chmod(script, 0o644);
    const noExec = await hashTaskDir(path.join(root, "task"), "linux");
    expect(noExec).not.toBe(FIXTURE_HASH);
    // Windows has no exec bits: `.sh` files count as 755.
    expect(await hashTaskDir(path.join(root, "task"), "win32")).toBe(
      FIXTURE_HASH,
    );
    // Content and path changes change the hash.
    await chmod(script, 0o755);
    await write("task/a/b.txt", "z");
    expect(await hashTaskDir(path.join(root, "task"))).not.toBe(FIXTURE_HASH);
  });
});

void describe("packTaskDir", () => {
  void it("packs exactly the hashed files, relative to the task dir", async () => {
    await writeFixture();
    await write("task/.env", "SECRET=1");
    await write("task/node_modules/pkg/index.js");
    await symlink("task.toml", path.join(root, "task/link.toml"));

    const { hash, archive, index } = await packTaskDir(
      path.join(root, "task"),
      "linux",
    );

    expect(hash).toBe(FIXTURE_HASH);
    const entries = (await unpackTar(gunzipSync(archive))).filter(
      (e) => e.header.type === "file",
    );
    expect(entries.map((e) => e.header.name).sort()).toEqual([
      "a-b.txt",
      "a/b.txt",
      "task.toml",
      "tests/test.sh",
    ]);
    expect(index.map((f) => f.path).sort()).toEqual([
      "a-b.txt",
      "a/b.txt",
      "task.toml",
      "tests/test.sh",
    ]);
    const modes = Object.fromEntries(
      entries.map((e) => [e.header.name, e.header.mode! & 0o777]),
    );
    expect(modes["tests/test.sh"]).toBe(0o755);
    expect(modes["task.toml"]).toBe(0o644);
  });

  void it("extracts back to a dir with the same hash", async () => {
    await writeFixture();
    const { archive } = await packTaskDir(path.join(root, "task"));
    const out = path.join(root, "out");

    await extractVersion(Readable.from([archive]), out);

    expect(await hashTaskDir(out)).toBe(FIXTURE_HASH);
    expect(await readFile(path.join(out, "a/b.txt"), "utf8")).toBe("y");
    expect((await stat(path.join(out, "tests/test.sh"))).mode & 0o100).toBe(
      0o100,
    );
    // Extracted files get current mtimes, not the archive's fixed epoch.
    expect((await stat(path.join(out, "task.toml"))).mtimeMs).toBeGreaterThan(
      0,
    );
  });
});
