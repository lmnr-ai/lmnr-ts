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
import { parseTaskSetSelector, prepareAgents } from "./prepare";
import { AGENT_SCRIPTS, ensureBlob } from "./store";
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
    getLatestScripts: async (agent: string) => scripts.get(agent) ?? null,
  };
  return {
    client: { hostedEvals } as unknown as LaminarClient,
    head: (set = "s") => setOf(set).head,
    createTaskSetVersion: hostedEvals.createTaskSetVersion,
    /** What creating an evaluation of `agent` with these scripts records. */
    recordScripts: (agent: string, hash: string) => {
      const latest = {
        hash,
        gitSha: null,
        usedAt: "2026-11-17T00:00:00Z",
        evaluationId: `e-${nextId++}`,
      };
      scripts.set(agent, latest);
      return latest;
    },
  };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-sync-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("pushTaskSet / pullTaskSet", () => {
  void it("pushes, then merges a concurrent push task by task before pushing again", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/task_sets/s");
    const theirs = path.join(root, "theirs/task_sets/s");
    await write("mine/task_sets/s/a/task.toml", toml("a1"));
    await write("mine/task_sets/s/b/task.toml", toml("b1"));

    const v1 = await pushTaskSet(server.client, "agent", "s", mine);
    expect(v1.number).toBe(1);
    expect((await readState(mine))?.versionId).toBe(v1.id);

    // Someone else pulls v1, changes `b` and adds `c`, and pushes first.
    await pullTaskSet(server.client, "agent", "s", theirs, v1);
    await write("theirs/task_sets/s/b/task.toml", toml("b2"));
    await write("theirs/task_sets/s/c/task.toml", toml("c1"));
    const v2 = await pushTaskSet(server.client, "agent", "s", theirs);
    expect(v2.number).toBe(2);

    // My push of a change to `a` merges theirs in and lands on top.
    await write("mine/task_sets/s/a/task.toml", toml("a2"));
    const v3 = await pushTaskSet(server.client, "agent", "s", mine);
    expect(v3.number).toBe(3);
    expect(v3.parentId).toBe(v2.id);
    expect(await read("mine/task_sets/s/a/task.toml")).toBe(toml("a2"));
    expect(await read("mine/task_sets/s/b/task.toml")).toBe(toml("b2"));
    expect(await read("mine/task_sets/s/c/task.toml")).toBe(toml("c1"));
    expect(server.head()?.id).toBe(v3.id);
  });

  void it("merges files beside the tasks like tasks, deletions included", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/s");
    const theirs = path.join(root, "theirs/s");
    await write("mine/s/a/task.toml", toml("a1"));
    await write("mine/s/README.md", "readme");
    const v1 = await pushTaskSet(server.client, "agent", "s", mine);

    // They drop the README; I add notes. Both survive the merge as intended.
    await pullTaskSet(server.client, "agent", "s", theirs, v1);
    await rm(path.join(theirs, "README.md"));
    const v2 = await pushTaskSet(server.client, "agent", "s", theirs);
    await write("mine/s/NOTES.md", "notes");
    await pullTaskSet(server.client, "agent", "s", mine, v2);

    await expect(read("mine/s/README.md")).rejects.toThrow();
    expect(await read("mine/s/NOTES.md")).toBe("notes");
    expect((await readState(mine))?.files).toEqual({});
  });

  void it("refuses to merge a task both sides changed, leaving the copy as is", async () => {
    const server = fakeServer();
    const mine = path.join(root, "mine/s");
    await write("mine/s/a/task.toml", toml("a1"));
    const v1 = await pushTaskSet(server.client, "agent", "s", mine);

    await cp(mine, path.join(root, "theirs/s"), { recursive: true });
    await write("theirs/s/a/task.toml", toml("theirs"));
    await pushTaskSet(server.client, "agent", "s", path.join(root, "theirs/s"));

    await write("mine/s/a/task.toml", toml("mine"));
    await expect(
      pushTaskSet(server.client, "agent", "s", mine),
    ).rejects.toMatchObject({ code: "merge_conflict", exitCode: 22 });
    expect(await read("mine/s/a/task.toml")).toBe(toml("mine"));
    expect((await readState(mine))?.versionId).toBe(v1.id);
  });
});

/** An agent whose last run's scripts (agent.yaml = `yaml`) and task set `s` are in Laminar. */
const agentInLaminar = async (yaml: string) => {
  const server = fakeServer();
  await write("laminar/agent/agent.yaml", yaml);
  await write("laminar/agent/task_sets/s/a/task.toml", toml("a1"));
  const scripts = server.recordScripts(
    "agent",
    await ensureBlob(
      server.client,
      path.join(root, "laminar/agent"),
      AGENT_SCRIPTS,
    ),
  );
  await pushTaskSet(
    server.client,
    "agent",
    "s",
    path.join(root, "laminar/agent/task_sets/s"),
  );
  vi.mocked(buildEvalClient).mockResolvedValue(server.client);
  return { server, scripts };
};

void describe("pullScripts / handleEvalPull", () => {
  void it("refuses to overwrite a changed local script unless forced, keeping extra files", async () => {
    const { server, scripts } = await agentInLaminar("laminar");
    const agentDir = path.join(root, "repo/agent");
    await write("repo/agent/agent.yaml", "mine");
    await write("repo/agent/notes.md", "notes");

    await expect(
      pullScripts(server.client, agentDir, scripts.hash, false),
    ).rejects.toMatchObject({ code: "merge_conflict", exitCode: 22 });
    expect(await read("repo/agent/agent.yaml")).toBe("mine");

    await pullScripts(server.client, agentDir, scripts.hash, true);
    expect(await read("repo/agent/agent.yaml")).toBe("laminar");
    expect(await read("repo/agent/notes.md")).toBe("notes");
  });

  void it("treats a local symlink on a script's path as a change and replaces only the link", async () => {
    const { server, scripts } = await agentInLaminar("laminar");
    const agentDir = path.join(root, "repo/agent");
    await write("shared/agent.yaml", "mine");
    await mkdir(agentDir, { recursive: true });
    await symlink(
      path.join(root, "shared/agent.yaml"),
      path.join(agentDir, "agent.yaml"),
    );

    await expect(
      pullScripts(server.client, agentDir, scripts.hash, false),
    ).rejects.toMatchObject({ code: "merge_conflict" });

    await pullScripts(server.client, agentDir, scripts.hash, true);
    expect((await lstat(path.join(agentDir, "agent.yaml"))).isFile()).toBe(
      true,
    );
    expect(await read("repo/agent/agent.yaml")).toBe("laminar");
    expect(await read("shared/agent.yaml")).toBe("mine");
  });

  void it("pulls only the scripts the last run used for <agent>", async () => {
    const { server } = await agentInLaminar("job: {}\n");
    await write("laminar/agent/agent.yaml", "job:\n  n_attempts: 2\n");
    server.recordScripts(
      "agent",
      await ensureBlob(
        server.client,
        path.join(root, "laminar/agent"),
        AGENT_SCRIPTS,
      ),
    );
    await handleEvalPull("agent", { dir: path.join(root, "repo") });
    expect(await read("repo/agent/agent.yaml")).toBe("job:\n  n_attempts: 2\n");
    await expect(read("repo/agent/task_sets/s/a/task.toml")).rejects.toThrow();
    await expect(read("repo/agent/.gitignore")).rejects.toThrow();
  });

  void it("fails for <agent> when no evaluation recorded its scripts", async () => {
    await agentInLaminar("job: {}\n");
    await expect(
      handleEvalPull("other", { dir: path.join(root, "repo") }),
    ).rejects.toMatchObject({ code: "not_found", exitCode: 23 });
  });

  void it("pulls the pinned task sets for --all, keeping local scripts and ignoring task_sets/ once", async () => {
    const { server } = await agentInLaminar("laminar");
    await write("laminar/t/a/task.toml", toml("t1"));
    await pushTaskSet(
      server.client,
      "agent",
      "t",
      path.join(root, "laminar/t"),
    );
    const mine = "task_sets:\n  s: 1\n";
    await write("repo/agent/agent.yaml", mine);
    await write("repo/agent/.gitignore", "jobs/");
    await handleEvalPull("agent", { dir: path.join(root, "repo"), all: true });
    expect(await read("repo/agent/agent.yaml")).toBe(mine);
    expect(await read("repo/agent/task_sets/s/a/task.toml")).toBe(toml("a1"));
    await expect(read("repo/agent/task_sets/t/a/task.toml")).rejects.toThrow();
    await handleEvalPull("agent/s", { dir: path.join(root, "repo") });
    expect(await read("repo/agent/.gitignore")).toBe("jobs/\ntask_sets/\n");
  });

  void it("fills in the scripts for --all when there are none locally", async () => {
    await agentInLaminar("task_sets:\n  s: 1\n");
    await handleEvalPull("agent", { dir: path.join(root, "repo"), all: true });
    expect(await read("repo/agent/agent.yaml")).toBe("task_sets:\n  s: 1\n");
    expect(await read("repo/agent/task_sets/s/a/task.toml")).toBe(toml("a1"));
  });
});

/** Laminar has `pinned` v1 and v2 and `other` v1; the repo pins `pinned: 1`. */
const pinnedRepo = async () => {
  const server = fakeServer();
  vi.mocked(buildEvalClient).mockResolvedValue(server.client);
  const push = async (set: string, value: string) => {
    await write(`laminar/${set}/a/task.toml`, toml(value));
    return pushTaskSet(
      server.client,
      "agent",
      set,
      path.join(root, `laminar/${set}`),
    );
  };
  const v1 = await push("pinned", "p1");
  const v2 = await push("pinned", "p2");
  const other = await push("other", "o1");
  await write("repo/agent/agent.yaml", "task_sets:\n  pinned: 1\n");
  const run = (selectors: string[] = []) =>
    prepareAgents(
      server.client,
      path.join(root, "repo"),
      ["agent"],
      selectors.map(parseTaskSetSelector),
      path.join(root, "scratch"),
    );
  const ran = async (selectors?: string[]) =>
    Object.fromEntries(
      (await run(selectors))[0].taskSets.map((s) => [s.name, s.hash]),
    );
  return { server, v1, v2, other, run, ran };
};

void describe("prepareAgents", () => {
  beforeEach(() => {
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  void it("runs pinned sets at their pin, leaving unpinned Laminar sets out", async () => {
    const { v1, ran } = await pinnedRepo();
    expect(await ran()).toEqual({ pinned: v1.hash });
  });

  void it("runs a named unpinned set at head, and @latest / @N over the pin", async () => {
    const { v1, v2, other, ran } = await pinnedRepo();
    expect(await ran(["other"])).toEqual({ other: other.hash });
    expect(await ran(["pinned"])).toEqual({ pinned: v1.hash });
    expect(await ran(["pinned@latest"])).toEqual({ pinned: v2.hash });
    expect(await ran(["pinned@2"])).toEqual({ pinned: v2.hash });
  });

  void it("takes a Laminar-only named set only for a run of one agent", async () => {
    const { server } = await pinnedRepo();
    await write("repo/second/agent.yaml", "job: {}\n");
    const runBoth = (selectors: string[]) =>
      prepareAgents(
        server.client,
        path.join(root, "repo"),
        ["agent", "second"],
        selectors.map(parseTaskSetSelector),
        path.join(root, "scratch"),
      );
    await expect(runBoth(["other"])).rejects.toMatchObject({
      code: "not_found",
    });
    const prepared = await runBoth(["pinned"]);
    expect(prepared.map((a) => a.agent.name)).toEqual(["agent"]);
  });

  void it("runs a local copy over the pin, warning about the difference", async () => {
    const { server, v2, run } = await pinnedRepo();
    const dir = path.join(root, "repo/agent/task_sets/pinned");
    await pullTaskSet(server.client, "agent", "pinned", dir, v2);
    const [agent] = await run();
    expect(agent.taskSets).toEqual([{ name: "pinned", hash: v2.hash, dir }]);
    expect(log.warn).toHaveBeenCalledWith(
      "Running your copy of agent/pinned (based on v2), but agent.yaml pins v1.",
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("not a pushed version"),
    );
  });

  void it("runs a never-pushed or edited copy as a blob, creating no version", async () => {
    const { server, v2, run } = await pinnedRepo();
    await write("repo/agent/task_sets/fresh/a/task.toml", toml("f1"));
    const pinnedDir = path.join(root, "repo/agent/task_sets/pinned");
    await pullTaskSet(server.client, "agent", "pinned", pinnedDir, v2);
    await write("repo/agent/task_sets/pinned/a/task.toml", toml("edited"));
    server.createTaskSetVersion.mockClear();

    const [agent] = await run();

    expect(server.createTaskSetVersion).not.toHaveBeenCalled();
    expect(agent.taskSets.map((s) => s.name)).toEqual(["fresh", "pinned"]);
    expect(agent.taskSets[1].hash).not.toBe(v2.hash);
    for (const set of ["fresh", "pinned"]) {
      expect(log.info).toHaveBeenCalledWith(
        `agent/${set}: running your local copy; it is not a pushed version, ` +
          "so the evaluation won't link to one " +
          `(\`lmnr-cli eval push agent/${set}\` publishes it).`,
      );
    }
  });

  void it("needs the repo's scripts", async () => {
    const { run } = await pinnedRepo();
    await rm(path.join(root, "repo/agent/agent.yaml"));
    await expect(run()).rejects.toMatchObject({
      code: "not_found",
      exitCode: 23,
      message: expect.stringContaining("`lmnr-cli eval pull agent` fetches"),
    });
  });
});

void describe("handleEvalPush", () => {
  void it("pushes local task sets only and hints at the pin", async () => {
    const { server, v2 } = await pinnedRepo();
    const dir = path.join(root, "repo/agent/task_sets/pinned");
    await pullTaskSet(server.client, "agent", "pinned", dir, v2);
    await write("repo/agent/task_sets/pinned/a/task.toml", toml("p3"));
    await write("repo/agent/task_sets/fresh/a/task.toml", toml("f1"));
    vi.mocked(log.info).mockClear();
    await handleEvalPush("agent", { dir: path.join(root, "repo") });
    expect(server.head("pinned")?.number).toBe(3);
    expect(server.head("fresh")?.number).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      "agent.yaml pins pinned to v1; set it to v3 to run this version in CI.",
    );
    expect(log.info).toHaveBeenCalledWith(
      "Pin it in agent.yaml (task_sets: {fresh: 1}) so runs and CI use this version.",
    );
    expect(await read("repo/agent/.gitignore")).toBe("task_sets/\n");
  });

  void it("pushes despite an invalid agent.yaml, skipping the pin hints", async () => {
    const { server } = await pinnedRepo();
    await write("repo/agent/agent.yaml", "task_sets:\n  fresh: zero\n");
    await write("repo/agent/task_sets/fresh/a/task.toml", toml("f1"));
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    await handleEvalPush("agent/fresh", { dir: path.join(root, "repo") });
    expect(server.head("fresh")?.number).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Skipping pin hints: /),
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Pin it in agent\.yaml/),
    );
  });
});
