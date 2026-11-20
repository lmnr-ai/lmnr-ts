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
import {
  collectTaskFiles,
  envFiles,
  hashTaskDir,
  packTaskDir,
} from "./task-hash";

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/**
 * Tasks whose hashes and file lists Harbor 0.25.0 computed itself
 * (`Packager.compute_content_hash`): `.harborignore` in `tests/` with a
 * negation, a task `.gitignore` replacing the default ignores, a link to a
 * file in the task, a non-ASCII path, files Harbor doesn't package.
 */
const writeFixtures = async () => {
  await write("t1/task.toml", '[task]\nname = "acme/t1"\n');
  await write("t1/instruction.md", "do it\n");
  await write("t1/README.md", "readme\n");
  await write("t1/trajectory.json", "{}\n");
  await write("t1/notes.md", "notes\n");
  await write("t1/other/x.txt", "x\n");
  await write("t1/environment/case.json", '{"a":1}\n');
  await write("t1/environment/sub/s.txt", "s\n");
  await write("t1/environment/.env", "SECRET=1\n");
  await write("t1/environment/.harborignore", "h\n");
  await write("t1/tests/test.sh", "#!/bin/bash\necho hi\n");
  await chmod(path.join(root, "t1/tests/test.sh"), 0o755);
  await write("t1/tests/data/big.bin", "big\n");
  await write("t1/tests/data/keep.bin", "keep\n");
  await write("t1/tests/expected.json", "ans\n");
  await write("t1/tests/.harborignore", "data/*.bin\n!data/keep.bin\n");
  await write("t1/solution/solve.sh", "sol\n");
  await write("t1/steps/s1/tests/t.sh", "st\n");
  await write("t1/steps/s1/instruction.md", "inst\n");
  await write("t1/.gitignore", "X.swp\n*.log\n");
  await write("t1/environment/a.log", "log\n");
  await write("t1/environment/b.swp", "swp\n");
  await write("t1/environment/ü.txt", "Ünï\n");
  await symlink(
    "../README.md",
    path.join(root, "t1/environment/readme-link.md"),
  );

  await write("t2/task.toml", '[task]\nname = "acme/t2"\n');
  await write("t2/environment/__pycache__/m.pyc", "x\n");
  await write("t2/environment/z.pyc", "y\n");
  await write("t2/tests/test.sh", "t\n");
  await write("t2/environment/.DS_Store", "s\n");
  await write("t2/environment/q~", "q\n");

  await write("t3/task.toml", "x");
  await write("t3/environment/B.txt", "A\n");
  await write("t3/environment/a.txt", "a\n");
};

const HARBOR = {
  t1: {
    hash: "5b053be281c1d0aec5ac87de9a6f0bfb2a05c863f8ed15b9dfe3d8ec382f3a8c",
    files: [
      "README.md",
      "environment/.env",
      "environment/b.swp",
      "environment/case.json",
      "environment/readme-link.md",
      "environment/sub/s.txt",
      "environment/ü.txt",
      "instruction.md",
      "solution/solve.sh",
      "steps/s1/instruction.md",
      "steps/s1/tests/t.sh",
      "task.toml",
      "tests/data/keep.bin",
      "tests/expected.json",
      "tests/test.sh",
      "trajectory.json",
    ],
  },
  t2: {
    hash: "b29901a2e36c2c7484844772a9a03af7359d7d63498e12f2419f7b98619db51e",
    files: ["task.toml", "tests/test.sh"],
  },
  t3: {
    hash: "09cb5b3ebd1a76b4d7464389966cef681f8fc738dfdcab606e4c53f1ea1d5655",
    files: ["environment/B.txt", "environment/a.txt", "task.toml"],
  },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-hash-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("hashTaskDir", () => {
  void it("matches Harbor's content hash and file selection", async () => {
    await writeFixtures();
    for (const [task, expected] of Object.entries(HARBOR)) {
      const dir = path.join(root, task);
      expect(
        (await collectTaskFiles(dir)).files.map((f) => f.target),
        task,
      ).toEqual(expected.files);
      expect(await hashTaskDir(dir), task).toBe(expected.hash);
    }
  });

  void it("ignores file modes", async () => {
    await writeFixtures();
    await chmod(path.join(root, "t1/tests/test.sh"), 0o644);
    expect(await hashTaskDir(path.join(root, "t1"))).toBe(HARBOR.t1.hash);
  });

  void it("refuses links that leave the task", async () => {
    await write("t/task.toml", "x");
    await write("outside.txt", "secret");
    await mkdir(path.join(root, "t/environment"));
    await symlink(
      path.join(root, "outside.txt"),
      path.join(root, "t/environment/link.txt"),
    );
    await expect(hashTaskDir(path.join(root, "t"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
    });
  });

  void it("lists the env files a push refuses", async () => {
    await writeFixtures();
    const { files } = await collectTaskFiles(path.join(root, "t1"));
    expect(envFiles(files)).toEqual(["environment/.env"]);
  });
});

void describe("packTaskDir", () => {
  void it("packs the hashed files and the ignore files that chose them", async () => {
    await writeFixtures();
    const packed = await packTaskDir(path.join(root, "t1"), "linux");
    expect(packed.hash).toBe(HARBOR.t1.hash);
    const archived = [
      ...HARBOR.t1.files,
      ".gitignore",
      "tests/.harborignore",
    ].sort();
    expect(packed.index.map((f) => f.path)).toEqual(archived);
    const entries = (await unpackTar(gunzipSync(packed.archive))).filter(
      (e) => e.header.type === "file",
    );
    expect(entries.map((e) => e.header.name)).toEqual(archived);
    const modes = Object.fromEntries(
      entries.map((e) => [e.header.name, (e.header.mode ?? 0) & 0o777]),
    );
    expect(modes["tests/test.sh"]).toBe(0o755);
    expect(modes["task.toml"]).toBe(0o644);
  });

  void it("extracts back to a dir with the same hash and exec bits", async () => {
    await writeFixtures();
    const packed = await packTaskDir(path.join(root, "t1"), "linux");
    const out = path.join(root, "out");
    await extractVersion(Readable.from([packed.archive]), out);
    expect(await hashTaskDir(out)).toBe(HARBOR.t1.hash);
    expect((await stat(path.join(out, "tests/test.sh"))).mode & 0o777).toBe(
      0o755,
    );
    // The link is packed as the file it points at.
    expect(
      await readFile(path.join(out, "environment/readme-link.md"), "utf8"),
    ).toBe("readme\n");
  });
});
