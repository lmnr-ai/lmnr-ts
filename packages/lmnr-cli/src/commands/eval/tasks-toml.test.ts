import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureGitignore,
  formatTasksToml,
  readState,
  readTasksToml,
  sameTasks,
  writeState,
  writeTasksToml,
} from "./tasks-toml";

const h = (c: string) => c.repeat(64);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-toml-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("tasks.toml", () => {
  void it("writes one [tasks] table sorted by name, quoting keys TOML would split", async () => {
    const tasks = {
      "refund-partial": h("b"),
      "10": h("c"),
      "v1.2": h("d"),
      A_b: h("a"),
    };
    await writeTasksToml(root, tasks);

    const text = await readFile(path.join(root, "tasks.toml"), "utf8");
    expect(text.split("\n").filter((l) => !l.startsWith("#"))).toEqual([
      "[tasks]",
      `10 = "${h("c")}"`,
      `A_b = "${h("a")}"`,
      `refund-partial = "${h("b")}"`,
      `"v1.2" = "${h("d")}"`,
      "",
    ]);
    expect(parseToml(text)).toEqual({ tasks });
    expect(await readTasksToml(root)).toEqual(tasks);
    expect(formatTasksToml({})).toMatch(/\[tasks\]\n$/);
  });

  void it("reads hand-written TOML: comments, quoting, an empty file", async () => {
    await writeFile(
      path.join(root, "tasks.toml"),
      `# pins\n[tasks]\n'lit.eral' = "${h("a")}"  # trailing\n"q" = '${h("b")}'\n`,
    );
    expect(await readTasksToml(root)).toEqual({
      "lit.eral": h("a"),
      q: h("b"),
    });
    await writeFile(path.join(root, "tasks.toml"), "");
    expect(await readTasksToml(root)).toEqual({});
  });

  void it("is absent without a file and rejected when malformed", async () => {
    expect(await readTasksToml(root)).toBeNull();
    for (const bad of [
      `[tasks]\na = "sha256:${h("a")}"\n`,
      `[tasks]\na = "${h("A")}"\n`,
      `[tasks]\n"../x" = "${h("a")}"\n`,
      `[tasks]\na.b = "${h("a")}"\n`,
      `dataset = "s"\n[tasks]\n`,
      "tasks = 1\n",
      "[tasks\n",
    ]) {
      await writeFile(path.join(root, "tasks.toml"), bad);
      await expect(readTasksToml(root)).rejects.toMatchObject({
        code: "invalid_evals_dir",
        message: expect.stringMatching(/is not a valid tasks\.toml/),
      });
    }
  });
});

void describe(".lmnr-state.json", () => {
  void it("round-trips, and an unreadable one is empty", async () => {
    await mkdir(path.join(root, "tasks"));
    const state = { tasks: { a: h("a"), b: h("b") }, localHashes: {} };
    await writeState(root, state);
    expect(await readState(root)).toEqual(state);
    expect(
      JSON.parse(
        await readFile(path.join(root, "tasks/.lmnr-state.json"), "utf8"),
      ),
    ).toEqual({ tasks: state.tasks });

    await writeState(root, { ...state, localHashes: { a: h("c") } });
    expect(await readState(root)).toEqual({
      ...state,
      localHashes: { a: h("c") },
    });
    // localHashes of unsynced tasks and invalid entries are dropped.
    await writeFile(
      path.join(root, "tasks/.lmnr-state.json"),
      JSON.stringify({
        tasks: { a: h("a"), b: "sha256:x" },
        localHashes: { z: h("c") },
      }),
    );
    expect(await readState(root)).toEqual({
      tasks: { a: h("a") },
      localHashes: {},
    });
    await writeFile(path.join(root, "tasks/.lmnr-state.json"), "{oops");
    expect(await readState(root)).toEqual({ tasks: {}, localHashes: {} });
  });
});

void describe("ensureGitignore", () => {
  void it("adds */tasks/ once, keeping what's there", async () => {
    expect(await ensureGitignore(root)).toBe(true);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "*/tasks/\n",
    );
    expect(await ensureGitignore(root)).toBe(false);

    await writeFile(path.join(root, ".gitignore"), "jobs/");
    expect(await ensureGitignore(root)).toBe(true);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "jobs/\n*/tasks/\n",
    );

    for (const existing of ["*/tasks", "*/tasks/", "/*/tasks", " /*/tasks/ "]) {
      await writeFile(path.join(root, ".gitignore"), `x\n${existing}\r\n`);
      expect(await ensureGitignore(root)).toBe(false);
    }
  });
});

void describe("sameTasks", () => {
  void it("compares task maps", () => {
    expect(sameTasks({ a: h("a") }, { a: h("a") })).toBe(true);
    expect(sameTasks({ a: h("a") }, { a: h("b") })).toBe(false);
    expect(sameTasks({ a: h("a") }, { b: h("a") })).toBe(false);
    expect(sameTasks({}, {})).toBe(true);
  });
});
