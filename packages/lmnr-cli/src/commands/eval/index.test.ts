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

import { packEvalsDir, parseEnvFlags, parsePositiveInt } from "./index";

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const entriesOf = async (archive: Buffer) =>
  (await unpackTar(gunzipSync(archive))).filter(
    (e) => e.header.type === "file",
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-evals-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("packEvalsDir", () => {
  void it("packs the folder's contents with suites at the archive root", async () => {
    await write("hello/harbor.yaml", "agents: []");
    await write("hello/tasks/hello-world/task.toml");
    await write("other/harbor.yaml");
    await write("README.md");

    const { archive, suites, fileCount } = await packEvalsDir(root);

    expect(suites).toEqual(["hello", "other"]);
    expect(fileCount).toBe(4);
    const names = (await entriesOf(archive)).map((e) => e.header.name).sort();
    expect(names).toEqual([
      "README.md",
      "hello/harbor.yaml",
      "hello/tasks/hello-world/task.toml",
      "other/harbor.yaml",
    ]);
    const config = (await entriesOf(archive)).find(
      (e) => e.header.name === "hello/harbor.yaml",
    );
    expect(Buffer.from(config!.data!).toString()).toBe("agents: []");
  });

  void it("never uploads env files, VCS data, deps or caches", async () => {
    await write("hello/harbor.yaml");
    await write(".env", "SECRET=1");
    await write("hello/.env.local", "SECRET=1");
    await write(".git/config");
    await write("hello/node_modules/pkg/index.js");
    await write("hello/.venv/bin/python");
    await write("hello/tasks/t/__pycache__/x.pyc");
    await write("hello/tasks/t/environment/Dockerfile");

    const { archive } = await packEvalsDir(root);

    const names = (await entriesOf(archive)).map((e) => e.header.name).sort();
    expect(names).toEqual([
      "hello/harbor.yaml",
      "hello/tasks/t/environment/Dockerfile",
    ]);
  });

  void it("keeps the executable bit and skips symlinks", async () => {
    await write("hello/harbor.yaml");
    await write("hello/tasks/t/tests/test.sh", "#!/bin/sh");
    await chmod(path.join(root, "hello/tasks/t/tests/test.sh"), 0o755);
    await symlink("/etc/passwd", path.join(root, "hello/passwd"));

    const { archive, skippedSymlinks } = await packEvalsDir(root);

    expect(skippedSymlinks).toEqual(["hello/passwd"]);
    const script = (await entriesOf(archive)).find(
      (e) => e.header.name === "hello/tasks/t/tests/test.sh",
    );
    expect(script!.header.mode! & 0o111).toBe(0o111);
  });

  void it("rejects a folder without suites at its root", async () => {
    await write("evals/hello/harbor.yaml");

    await expect(packEvalsDir(root)).rejects.toMatchObject({
      code: "invalid_evals_dir",
      exitCode: 16,
    });
  });

  void it("rejects a missing folder", async () => {
    await expect(
      packEvalsDir(path.join(root, "missing")),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });
});

void describe("parseEnvFlags", () => {
  void it("takes KEY=VALUE as-is and reads a bare KEY from the env", () => {
    expect(
      parseEnvFlags(["A=1", "B=x=y", "C=", "OPENAI_API_KEY"], {
        OPENAI_API_KEY: "sk",
      }),
    ).toEqual({ A: "1", B: "x=y", C: "", OPENAI_API_KEY: "sk" });
  });

  void it("errors on an unset bare KEY", () => {
    expect(() => parseEnvFlags(["MISSING"], {})).toThrow(/not set/);
  });

  void it("errors on an invalid key", () => {
    expect(() => parseEnvFlags(["=1"], {})).toThrow(/Invalid --env/);
    expect(() => parseEnvFlags(["1A=1"], {})).toThrow(/Invalid --env/);
  });
});

void describe("parsePositiveInt", () => {
  void it("accepts positive integers only", () => {
    expect(parsePositiveInt("3")).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parsePositiveInt(bad)).toThrow(/positive integer/);
    }
  });
});
