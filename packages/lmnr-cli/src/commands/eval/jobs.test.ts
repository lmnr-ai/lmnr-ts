import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_JOB_FILE_BYTES, packJobDir, scrub, secretValues } from "./jobs";

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

void describe("secretValues", () => {
  void it("takes Harbor's sensitive names, longest first, minus flags", () => {
    expect(
      secretValues({
        OPENAI_API_KEY: "sk-short",
        LMNR_PROJECT_API_KEY: "lmnr-project-key-value",
        GITHUB_TOKEN: "ghp_x",
        MAX_TOKENS: "4096",
        MODEL: "gpt-5",
        USE_AUTH: "true",
        EMPTY_SECRET: " ",
      }),
    ).toEqual(["lmnr-project-key-value", "sk-short", "ghp_x"]);
  });
});

void describe("scrub", () => {
  void it("replaces every occurrence, longest secret first", () => {
    const out = scrub(Buffer.from("a sk-abc-long b sk-abc c sk-abc-long"), [
      "sk-abc-long",
      "sk-abc",
    ]);
    expect(out.toString()).toBe("a [REDACTED] b [REDACTED] c [REDACTED]");
  });

  void it("returns the same buffer when nothing matches", () => {
    const content = Buffer.from("nothing here");
    expect(scrub(content, ["secret"])).toBe(content);
  });
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

    const { index, skipped } = await packJobDir(root, []);

    expect(index.map((f) => f.path)).toEqual([
      "hello__abc/agent/oracle.txt",
      "hello__abc/steps/one/agent/out.txt",
      "hello__abc/trial.log",
    ]);
    expect(skipped).toEqual(["hello__abc/agent/huge.txt"]);
  });

  void it("scrubs text files before packing and indexes the new sizes", async () => {
    await write("t__1/agent/out.txt", "key=sk-secret-value end");
    await write(
      "t__1/agent/blob.bin",
      Buffer.concat([Buffer.from([0]), Buffer.from("sk-secret-value")]),
    );

    const { archive, index } = await packJobDir(root, ["sk-secret-value"]);

    const contents = Object.fromEntries(
      index.map((file) => {
        const member = gunzipSync(
          archive.subarray(file.offset, file.offset + file.length),
        );
        const content = member.subarray(
          file.dataOffset,
          file.dataOffset + file.size,
        );
        return [file.path, content.toString()];
      }),
    );
    expect(contents["t__1/agent/out.txt"]).toBe("key=[REDACTED] end");
    // Binary files are left as they are, as Harbor's own scrub does.
    expect(contents["t__1/agent/blob.bin"]).toContain("sk-secret-value");
    expect(await readFile(path.join(root, "t__1/agent/out.txt"), "utf8")).toBe(
      "key=[REDACTED] end",
    );
  });
});
