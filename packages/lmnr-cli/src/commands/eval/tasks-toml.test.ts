import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDatasetState, writeDatasetState } from "./dataset-state";
import { ensureGitignore } from "./datasets";
import {
  formatTasksToml,
  parseTasksToml,
  readTasksToml,
  writeTasksToml,
} from "./tasks-toml";

const A = "a".repeat(64);
const B = "b".repeat(64);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-toml-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("tasks.toml", () => {
  void it("writes a header and sorted keys, and reads them back", async () => {
    const pins = { "refund.v2": B, Zeta: A, "customer-complaint": A, a_b: B };
    await writeTasksToml(root, pins);
    const text = await readFile(path.join(root, "tasks.toml"), "utf8");
    expect(text).toBe(
      "# Managed by lmnr-cli (eval dataset pull / push). Task versions are " +
        "content hashes.\n" +
        "[tasks]\n" +
        `Zeta = "${A}"\n` +
        `a_b = "${B}"\n` +
        `customer-complaint = "${A}"\n` +
        `"refund.v2" = "${B}"\n`,
    );
    expect(await readTasksToml(root)).toEqual(pins);
    expect(formatTasksToml({})).toMatch(/\[tasks\]\n$/);
    expect(parseTasksToml(formatTasksToml({}), "t")).toEqual({});
  });

  void it("is null without a tasks.toml", async () => {
    expect(await readTasksToml(root)).toBeNull();
  });

  void it("rejects other tables, keys and invalid hashes", () => {
    const bad = [
      `[tasks]\nrefund = "${A}"\n[other]\nx = 1\n`,
      `name = "x"\n[tasks]\n`,
      `[tasks]\nrefund = 1\n`,
      `[tasks]\nrefund = "${A.toUpperCase()}"\n`,
      `[tasks]\nrefund = "abc"\n`,
      `[tasks.refund]\nhash = "${A}"\n`,
      `[tasks]\n"-bad" = "${A}"\n`,
      `tasks = "x"\n`,
      "[tasks\n",
    ];
    for (const text of bad) {
      expect(() => parseTasksToml(text, "tasks.toml")).toThrow(
        expect.objectContaining({ code: "invalid_evals_dir", exitCode: 16 }),
      );
    }
    expect(parseTasksToml(`# hi\n[tasks]\nrefund = "${A}"\n`, "t")).toEqual({
      refund: A,
    });
  });
});

void describe("dataset state", () => {
  void it("round-trips and ignores invalid entries", async () => {
    expect(await readDatasetState(root)).toEqual({});
    await writeDatasetState(root, { b: B, a: A });
    const file = path.join(root, "tasks/.lmnr-state.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      tasks: { a: A, b: B },
    });
    expect(await readDatasetState(root)).toEqual({ a: A, b: B });

    await writeFile(
      file,
      JSON.stringify({ tasks: { ok: A, bad: "nope", ".x": A } }),
    );
    expect(await readDatasetState(root)).toEqual({ ok: A });
    await writeFile(file, "{not json");
    await expect(readDatasetState(root)).rejects.toMatchObject({
      code: "invalid_evals_dir",
    });
  });
});

void describe("ensureGitignore", () => {
  void it("appends */tasks/ once, keeping what is there", async () => {
    const file = path.join(root, ".gitignore");
    await ensureGitignore(root);
    expect(await readFile(file, "utf8")).toMatch(/^# .*\n\*\/tasks\/\n$/);

    await writeFile(file, "jobs/\n.env");
    await ensureGitignore(root);
    await ensureGitignore(root);
    const text = await readFile(file, "utf8");
    expect(text.startsWith("jobs/\n.env\n")).toBe(true);
    expect(text.split("\n").filter((l) => l === "*/tasks/")).toHaveLength(1);

    await mkdir(path.join(root, "x"));
    await writeFile(path.join(root, "x/.gitignore"), "  */tasks/  \n");
    await ensureGitignore(path.join(root, "x"));
    expect(await readFile(path.join(root, "x/.gitignore"), "utf8")).toBe(
      "  */tasks/  \n",
    );
  });
});
