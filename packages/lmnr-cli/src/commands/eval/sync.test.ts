import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CreateTaskSetVersionOptions,
  LaminarClient,
  LatestScripts,
  TaskSetVersion,
} from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEvalClient } from "./client";
import { readState } from "./layout";
import { walkFiles } from "./pack";
import { parseTaskSetSelector, prepareRun } from "./prepare";
import { downloadBlob, ensureBlob, scriptsOf } from "./store";
import {
  handleEvalPull,
  handleEvalPush,
  pullScripts,
  pullTaskSet,
  pushTaskSet,
} from "./sync";

vi.mock("./client", () => ({ buildEvalClient: vi.fn() }));

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ initializeLogger: () => log }));

let root: string;

const write = async (rel: string, content: string) => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const read = (rel: string) => readFile(path.join(root, rel), "utf8");

/** A task.toml whose content tells versions apart. */
const toml = (value: string) =>
  `[environment]\ndocker_image = "app"\n\n[metadata]\nvalue = "${value}"\n`;

/** Laminar's task set and scripts routes, in memory. */
const fakeServer = () => {
  const blobs = new Map<string, Buffer>();
  const sets = new Map<
    string,
    { versions: TaskSetVersion[]; head: TaskSetVersion | null }
  >();
  const setOf = (name: string) => {
    let set = sets.get(name);
    if (!set) {
      set = { versions: [], head: null };
      sets.set(name, set);
    }
    return set;
  };
  const scripts = new Map<string, LatestScripts>();
  let nextId = 1;
  const hostedEvals = {
    getBlobIndex: async (hash: string) => (blobs.has(hash) ? {} : null),
    putBlob: async (hash: string, archive: Uint8Array) => {
      blobs.set(hash, Buffer.from(archive));
    },
    putBlobIndex: async () => undefined,
    getBlob: async (hash: string) =>
      new Blob([new Uint8Array(blobs.get(hash) as Buffer)]).stream(),
    createTaskSetVersion: vi.fn(
      async (name: string, { hash, base }: CreateTaskSetVersionOptions) => {
        const set = setOf(name);
        if (set.head?.hash === hash) return { version: set.head };
        if ((set.head?.id ?? null) !== base) return { headMoved: set.head };
        const version: TaskSetVersion = {
          id: `v-${nextId++}`,
          number: set.versions.length + 1,
          hash,
          createdAt: "",
          parentId: base,
        };
        set.versions.push(version);
        set.head = version;
        return { version };
      },
    ),
    listTaskSetVersions: async (name: string) =>
      sets.has(name) ? [...setOf(name).versions].reverse() : null,
    listTaskSets: async () =>
      [...sets].map(([name, set]) => ({ id: name, name, head: set.head })),
    getLatestScripts: async (taskSet: string) => scripts.get(taskSet) ?? null,
  };
  return {
    client: { hostedEvals } as unknown as LaminarClient,
    head: (set = "s") => setOf(set).head,
    createTaskSetVersion: hostedEvals.createTaskSetVersion,
    /** What creating an evaluation of `taskSet` with these scripts records. */
    recordScripts: (taskSet: string, hash: string) => {
      const latest = {
        hash,
        gitSha: null,
        usedAt: "2026-11-17T00:00:00Z",
        evaluationId: `e-${nextId++}`,
      };
      scripts.set(taskSet, latest);
      return latest;
    },
  };
};

/** The files of blob `hash`, by path. */
const blobFiles = async (
  server: ReturnType<typeof fakeServer>,
  hash: string,
) => {
  const dir = await mkdtemp(path.join(root, "blob-"));
  await downloadBlob(server.client, hash, dir);
  return (await walkFiles(dir)).files.map((f) => f.target).sort();
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-sync-"));
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("pushTaskSet / pullTaskSet", () => {
  void it("pushes, then merges a concurrent push task by task before pushing again", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/s/tasks");
    const theirs = path.join(root, "theirs/s/tasks");
    await write("mine/s/tasks/a/task.toml", toml("a1"));
    await write("mine/s/tasks/b/task.toml", toml("b1"));

    const v1 = await pushTaskSet(server.client, "s", mine);
    expect(v1.number).toBe(1);
    expect((await readState(mine))?.versionId).toBe(v1.id);

    // Someone else pulls v1, changes `b` and adds `c`, and pushes first.
    await pullTaskSet(server.client, "s", theirs, v1);
    await write("theirs/s/tasks/b/task.toml", toml("b2"));
    await write("theirs/s/tasks/c/task.toml", toml("c1"));
    const v2 = await pushTaskSet(server.client, "s", theirs);
    expect(v2.number).toBe(2);

    // My push of a change to `a` merges theirs in and lands on top.
    await write("mine/s/tasks/a/task.toml", toml("a2"));
    const v3 = await pushTaskSet(server.client, "s", mine);
    expect(v3.number).toBe(3);
    expect(v3.parentId).toBe(v2.id);
    expect(await read("mine/s/tasks/a/task.toml")).toBe(toml("a2"));
    expect(await read("mine/s/tasks/b/task.toml")).toBe(toml("b2"));
    expect(await read("mine/s/tasks/c/task.toml")).toBe(toml("c1"));
    expect(server.head()?.id).toBe(v3.id);
  });

  void it("merges files beside the tasks like tasks, deletions included", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/s/tasks");
    const theirs = path.join(root, "theirs/s/tasks");
    await write("mine/s/tasks/a/task.toml", toml("a1"));
    await write("mine/s/tasks/README.md", "readme");
    const v1 = await pushTaskSet(server.client, "s", mine);

    // They drop the README; I add notes. Both survive the merge as intended.
    await pullTaskSet(server.client, "s", theirs, v1);
    await rm(path.join(theirs, "README.md"));
    const v2 = await pushTaskSet(server.client, "s", theirs);
    await write("mine/s/tasks/NOTES.md", "notes");
    await pullTaskSet(server.client, "s", mine, v2);

    await expect(read("mine/s/tasks/README.md")).rejects.toThrow();
    expect(await read("mine/s/tasks/NOTES.md")).toBe("notes");
    expect((await readState(mine))?.files).toEqual({});
  });

  void it("refuses to merge a task both sides changed, leaving the copy as is", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/s/tasks");
    await write("mine/s/tasks/a/task.toml", toml("a1"));
    const v1 = await pushTaskSet(server.client, "s", mine);

    const theirs = path.join(root, "theirs/s/tasks");
    await cp(mine, theirs, { recursive: true });
    await write("theirs/s/tasks/a/task.toml", toml("theirs"));
    await pushTaskSet(server.client, "s", theirs);

    await write("mine/s/tasks/a/task.toml", toml("mine"));
    await expect(pushTaskSet(server.client, "s", mine)).rejects.toMatchObject({
      code: "merge_conflict",
      exitCode: 22,
    });
    expect(await read("mine/s/tasks/a/task.toml")).toBe(toml("mine"));
    expect((await readState(mine))?.versionId).toBe(v1.id);
  });
});

/**
 * Laminar has task set `s` v1, and the scripts its last run used: the evals
 * folder `s/` (eval.yaml = `yaml`), a shared `common/` and another set `other/`.
 */
const setInLaminar = async (yaml = "laminar") => {
  const server = fakeServer();
  const evals = path.join(root, "laminar/evals");
  await write("laminar/evals/s/eval.yaml", yaml);
  await write("laminar/evals/s/adapter.py", "adapter");
  await write("laminar/evals/common/shared.py", "shared");
  await write("laminar/evals/other/eval.yaml", "other");
  await write("laminar/evals/s/tasks/a/task.toml", toml("a1"));
  const scripts = server.recordScripts(
    "s",
    await ensureBlob(server.client, evals, await scriptsOf(evals)),
  );
  await pushTaskSet(server.client, "s", path.join(evals, "s/tasks"));
  vi.mocked(buildEvalClient).mockResolvedValue(server.client);
  return { server, scripts };
};

const repo = () => ({ dir: path.join(root, "repo/evals") });

void describe("eval pull", () => {
  void it("fetches a missing set's scripts (its folder and shared ones), then its tasks", async () => {
    await setInLaminar();
    await handleEvalPull(["s"], repo());
    expect(await read("repo/evals/s/eval.yaml")).toBe("laminar");
    expect(await read("repo/evals/s/adapter.py")).toBe("adapter");
    expect(await read("repo/evals/common/shared.py")).toBe("shared");
    await expect(read("repo/evals/other/eval.yaml")).rejects.toThrow();
    expect(await read("repo/evals/s/tasks/a/task.toml")).toBe(toml("a1"));
    expect(await read("repo/evals/s/.gitignore")).toBe("tasks/\n");
    expect(log.info).toHaveBeenCalledWith(
      "Pulled the scripts s's last run used (2026-11-17T00:00:00Z). Commit " +
        "them to your repo: eval run uses the repo's scripts.",
    );
  });

  void it("keeps the repo's scripts when the set has an eval.yaml", async () => {
    await setInLaminar();
    await write("repo/evals/s/eval.yaml", "mine");
    await write("repo/evals/s/.gitignore", "jobs/");
    await handleEvalPull(["s"], repo());
    await handleEvalPull(["s@1"], repo());
    expect(await read("repo/evals/s/eval.yaml")).toBe("mine");
    await expect(read("repo/evals/s/adapter.py")).rejects.toThrow();
    expect(await read("repo/evals/s/tasks/a/task.toml")).toBe(toml("a1"));
    expect(await read("repo/evals/s/.gitignore")).toBe("jobs/\ntasks/\n");
  });

  void it("pulls the tasks and warns when no run recorded the set's scripts", async () => {
    const { server } = await setInLaminar();
    await write("laminar/t/tasks/a/task.toml", toml("t1"));
    await pushTaskSet(server.client, "t", path.join(root, "laminar/t/tasks"));
    await handleEvalPull(["t"], repo());
    expect(await read("repo/evals/t/tasks/a/task.toml")).toBe(toml("t1"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^t has no scripts: no .*eval\.yaml/),
    );
  });

  void it("fails for a task set Laminar doesn't have", async () => {
    await setInLaminar();
    await expect(handleEvalPull(["ghost"], repo())).rejects.toMatchObject({
      code: "not_found",
      exitCode: 23,
    });
  });

  void it("refuses to overwrite a changed local script unless forced, keeping extra files", async () => {
    const { server, scripts } = await setInLaminar();
    const evals = path.join(root, "repo/evals");
    await write("repo/evals/common/shared.py", "mine");
    await write("repo/evals/common/notes.md", "notes");

    await expect(
      pullScripts(server.client, evals, "s", scripts.hash, false),
    ).rejects.toMatchObject({ code: "merge_conflict", exitCode: 22 });
    expect(await read("repo/evals/common/shared.py")).toBe("mine");
    await expect(read("repo/evals/s/eval.yaml")).rejects.toThrow();

    await pullScripts(server.client, evals, "s", scripts.hash, true);
    expect(await read("repo/evals/common/shared.py")).toBe("shared");
    expect(await read("repo/evals/common/notes.md")).toBe("notes");
  });

  void it("treats a local symlink on a script's path as a change and replaces only the link", async () => {
    const { server, scripts } = await setInLaminar();
    const evals = path.join(root, "repo/evals");
    await write("elsewhere/adapter.py", "mine");
    await mkdir(path.join(evals, "s"), { recursive: true });
    await symlink(
      path.join(root, "elsewhere/adapter.py"),
      path.join(evals, "s/adapter.py"),
    );

    await expect(
      pullScripts(server.client, evals, "s", scripts.hash, false),
    ).rejects.toMatchObject({ code: "merge_conflict" });

    await pullScripts(server.client, evals, "s", scripts.hash, true);
    expect((await lstat(path.join(evals, "s/adapter.py"))).isFile()).toBe(true);
    expect(await read("repo/evals/s/adapter.py")).toBe("adapter");
    expect(await read("elsewhere/adapter.py")).toBe("mine");
  });

  void it("fails, even forced, when a local folder or file has the wrong kind for a script's path", async () => {
    const { server, scripts } = await setInLaminar();
    const evals = path.join(root, "repo/evals");
    await write("repo/evals/s/adapter.py/inner.py", "mine");
    await write("repo/evals/common", "a file, not a folder");

    for (const force of [false, true]) {
      await expect(
        pullScripts(server.client, evals, "s", scripts.hash, force),
      ).rejects.toMatchObject({
        code: "merge_conflict",
        message: expect.stringMatching(
          /folder where you have a file: common, s\/adapter\.py\./,
        ),
      });
    }
    expect(await read("repo/evals/s/adapter.py/inner.py")).toBe("mine");
    expect(await read("repo/evals/common")).toBe("a file, not a folder");
    await expect(read("repo/evals/s/eval.yaml")).rejects.toThrow();
  });
});

/**
 * Laminar has `pinned` v1 and v2 and `loose` v1. The repo has both sets'
 * folders; `pinned`'s eval.yaml pins v1.
 */
const pinnedRepo = async () => {
  const server = fakeServer();
  vi.mocked(buildEvalClient).mockResolvedValue(server.client);
  const push = async (set: string, value: string) => {
    await write(`laminar/${set}/tasks/a/task.toml`, toml(value));
    return pushTaskSet(
      server.client,
      set,
      path.join(root, `laminar/${set}/tasks`),
    );
  };
  const v1 = await push("pinned", "p1");
  const v2 = await push("pinned", "p2");
  const loose = await push("loose", "l1");
  await write("repo/evals/pinned/eval.yaml", "version: 1\n");
  await write("repo/evals/loose/eval.yaml", "job: {}\n");
  const evals = path.join(root, "repo/evals");
  const run = (selectors?: string[]) =>
    prepareRun(
      server.client,
      evals,
      (selectors ?? ["loose", "pinned"]).map(parseTaskSetSelector),
      path.join(root, "scratch"),
    );
  const ran = async (selectors?: string[]) =>
    Object.fromEntries(
      (await run(selectors)).taskSets.map((s) => [s.name, s.hash]),
    );
  return { server, evals, v1, v2, loose, run, ran };
};

void describe("prepareRun", () => {
  void it("runs a pinned set at its pin and an unpinned one at head, with a warning", async () => {
    const { v1, loose, ran } = await pinnedRepo();
    expect(await ran()).toEqual({ loose: loose.hash, pinned: v1.hash });
    expect(log.warn).toHaveBeenCalledWith(
      "loose isn't pinned: running the latest version, v1. Set `version: 1` " +
        "in its eval.yaml so CI runs a fixed version.",
    );
  });

  void it("takes @latest / @N over the pin", async () => {
    const { v2, ran } = await pinnedRepo();
    expect(await ran(["pinned@latest"])).toEqual({ pinned: v2.hash });
    expect(await ran(["pinned@2"])).toEqual({ pinned: v2.hash });
    await expect(ran(["pinned@9"])).rejects.toMatchObject({
      code: "not_found",
    });
  });

  void it("runs a local copy over the pin, warning about the difference", async () => {
    const { server, evals, v2, run } = await pinnedRepo();
    const dir = path.join(evals, "pinned/tasks");
    await pullTaskSet(server.client, "pinned", dir, v2);
    const { taskSets } = await run(["pinned"]);
    expect(taskSets.map((s) => [s.name, s.hash, s.tasksDir])).toEqual([
      ["pinned", v2.hash, dir],
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      "Running your copy of pinned (based on v2), but its eval.yaml pins v1.",
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("not a pushed version"),
    );
  });

  void it("runs a never-pushed or edited copy as a blob, creating no version", async () => {
    const { server, evals, v2, run } = await pinnedRepo();
    await write("repo/evals/fresh/eval.yaml", "job: {}\n");
    await write("repo/evals/fresh/tasks/a/task.toml", toml("f1"));
    await pullTaskSet(
      server.client,
      "pinned",
      path.join(evals, "pinned/tasks"),
      v2,
    );
    await write("repo/evals/pinned/tasks/a/task.toml", toml("edited"));
    server.createTaskSetVersion.mockClear();

    const { taskSets } = await run(["fresh", "pinned"]);

    expect(server.createTaskSetVersion).not.toHaveBeenCalled();
    expect(taskSets[1].hash).not.toBe(v2.hash);
    for (const set of ["fresh", "pinned"]) {
      expect(log.info).toHaveBeenCalledWith(
        `${set}: running your local copy; it is not a pushed version, so the ` +
          "evaluation won't link to one " +
          `(\`lmnr-cli eval push ${set}\` publishes it).`,
      );
    }
  });

  void it("uploads the evals folder as the scripts, shared folders in, tasks out", async () => {
    const { server, evals, v2, run } = await pinnedRepo();
    await write("repo/evals/common/shared.py", "shared");
    await pullTaskSet(
      server.client,
      "pinned",
      path.join(evals, "pinned/tasks"),
      v2,
    );
    const prepared = await run(["pinned"]);
    expect(await blobFiles(server, prepared.scriptsHash)).toEqual([
      "common/shared.py",
      "loose/eval.yaml",
      "pinned/eval.yaml",
    ]);
  });

  void it("needs the set's eval.yaml", async () => {
    const { run } = await pinnedRepo();
    await expect(run(["ghost"])).rejects.toMatchObject({
      code: "not_found",
      exitCode: 23,
      message: expect.stringContaining("`lmnr-cli eval pull ghost` fetches"),
    });
  });

  void it("fails for a set with no tasks anywhere", async () => {
    const { run } = await pinnedRepo();
    await write("repo/evals/fresh/eval.yaml", "job: {}\n");
    await expect(run(["fresh"])).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("Task set fresh has no tasks"),
    });
  });

  void it("refuses one image name defined differently by two sets", async () => {
    const { run } = await pinnedRepo();
    await write(
      "repo/evals/pinned/eval.yaml",
      "version: 1\nimages:\n  app:\n    dockerfile: ../common/Dockerfile\n",
    );
    await write(
      "repo/evals/loose/eval.yaml",
      "images:\n  app:\n    dockerfile: Dockerfile\n",
    );
    await expect(run()).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining("Image app is defined differently"),
    });
    await write(
      "repo/evals/loose/eval.yaml",
      "images:\n  app:\n    dockerfile: ../common/Dockerfile\n",
    );
    await expect(run()).resolves.toBeDefined();
  });
});

void describe("eval push", () => {
  void it("pushes the sets with a tasks copy and hints at the pin", async () => {
    const { server, evals, v2 } = await pinnedRepo();
    await pullTaskSet(
      server.client,
      "pinned",
      path.join(evals, "pinned/tasks"),
      v2,
    );
    await write("repo/evals/pinned/tasks/a/task.toml", toml("p3"));
    await write("repo/evals/fresh/eval.yaml", "job: {}\n");
    await write("repo/evals/fresh/tasks/a/task.toml", toml("f1"));
    await handleEvalPush([], { dir: evals });
    expect(server.head("pinned")?.number).toBe(3);
    expect(server.head("fresh")?.number).toBe(1);
    expect(server.head("loose")?.number).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      "pinned's eval.yaml pins v1; set `version: 3` to run this version in CI.",
    );
    expect(log.info).toHaveBeenCalledWith(
      `Pin it: set \`version: 1\` in ${path.join(evals, "fresh/eval.yaml")} ` +
        "so runs and CI use this version.",
    );
    expect(await read("repo/evals/fresh/.gitignore")).toBe("tasks/\n");
  });

  void it("pushes despite an invalid eval.yaml, skipping the pin hints", async () => {
    const { server, evals } = await pinnedRepo();
    await write("repo/evals/fresh/eval.yaml", "version: zero\n");
    await write("repo/evals/fresh/tasks/a/task.toml", toml("f1"));
    await handleEvalPush(["fresh"], { dir: evals });
    expect(server.head("fresh")?.number).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Skipping pin hints: /),
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/^Pin it/));
  });

  void it("fails for a set without a tasks copy", async () => {
    const { evals } = await pinnedRepo();
    await expect(
      handleEvalPush(["loose"], { dir: evals }),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });
});
