import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findJobDir, MAX_JOB_FILE_BYTES, packJobDir } from "./jobs";

let root: string;

const write = async (rel: string, content: string | Buffer = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-jobs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("packJobDir", () => {
  void it("packs trial dirs only, without artifacts or big files", async () => {
    await write("config.json", "{}");
    await write("job.log", "job");
    await write(".sources/t/task.toml", "");
    await write("hello__abc/trial.log", "trial");
    await write("hello__abc/agent/oracle.txt", "agent");
    await write("hello__abc/artifacts/manifest.json", "[]");
    await write("hello__abc/steps/one/agent/out.txt", "step");
    await write("hello__abc/steps/one/artifacts/big.bin", "a");
    await write(
      "hello__abc/agent/huge.txt",
      Buffer.alloc(MAX_JOB_FILE_BYTES + 1),
    );

    const { index, skipped } = await packJobDir(root);

    expect(index.map((f) => f.path)).toEqual([
      "hello__abc/agent/oracle.txt",
      "hello__abc/steps/one/agent/out.txt",
      "hello__abc/trial.log",
    ]);
    expect(skipped).toEqual(["hello__abc/agent/huge.txt"]);
  });
});

void describe("findJobDir", () => {
  void it("finds the job Harbor named, or nothing when it wrote none", async () => {
    expect(await findJobDir(path.join(root, "missing"))).toBeUndefined();
    await write(".lock", "");
    expect(await findJobDir(root)).toBeUndefined();
    await write("2026-11-12__09-40-03/config.json", "{}");
    expect(await findJobDir(root)).toBe(
      path.join(root, "2026-11-12__09-40-03"),
    );
  });
});
