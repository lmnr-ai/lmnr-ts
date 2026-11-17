import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CreateTaskSetVersionOptions,
  EvalAgent,
  LaminarClient,
  TaskSetVersion,
} from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEvalClient } from "./client";
import { readState } from "./layout";
import { AGENT_SCRIPTS, ensureBlob } from "./store";
import { handleEvalPull, pullScripts, pullTaskSet, pushTaskSet } from "./sync";

vi.mock("./client", () => ({ buildEvalClient: vi.fn() }));

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

/** Laminar's task set routes for one task set, in memory. */
const fakeServer = () => {
  const blobs = new Map<string, Buffer>();
  const versions: TaskSetVersion[] = [];
  let head: TaskSetVersion | null = null;
  const hostedEvals = {
    getBlobIndex: async (hash: string) => (blobs.has(hash) ? {} : null),
    putBlob: async (hash: string, archive: Uint8Array) => {
      blobs.set(hash, Buffer.from(archive));
    },
    putBlobIndex: async () => undefined,
    getBlob: async (hash: string) =>
      new Blob([new Uint8Array(blobs.get(hash) as Buffer)]).stream(),
    createTaskSetVersion: async (
      _agent: string,
      _set: string,
      { hash, push, base }: CreateTaskSetVersionOptions,
    ) => {
      let version = versions.find((v) => v.hash === hash);
      if (push && head && version?.id === head.id) return { version };
      if (push && (head?.id ?? null) !== base) return { headMoved: head };
      if (!version) {
        version = {
          id: `v-${versions.length + 1}`,
          number: null,
          hash,
          createdAt: "",
          parentId: base,
        };
        versions.push(version);
      }
      if (push) {
        version.number ??=
          Math.max(0, ...versions.map((v) => v.number ?? 0)) + 1;
        head = version;
      }
      return { version };
    },
  };
  return {
    client: { hostedEvals } as unknown as LaminarClient,
    head: () => head,
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

/** An agent whose scripts (agent.yaml = `yaml`) and task set `s` are in Laminar. */
const agentInLaminar = async (yaml: string) => {
  const server = fakeServer();
  await write("laminar/agent/agent.yaml", yaml);
  await write("laminar/agent/task_sets/s/a/task.toml", toml("a1"));
  const hash = await ensureBlob(
    server.client,
    path.join(root, "laminar/agent"),
    AGENT_SCRIPTS,
  );
  const scripts = { id: "a-1", number: 1, hash, gitSha: null, createdAt: "" };
  const set = await pushTaskSet(
    server.client,
    "agent",
    "s",
    path.join(root, "laminar/agent/task_sets/s"),
  );
  const agent: EvalAgent = {
    id: "agent",
    name: "agent",
    head: scripts,
    taskSets: [{ id: "s", name: "s", head: set }],
  };
  (server.client.hostedEvals as unknown as Record<string, unknown>).listAgents =
    async () => [agent];
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
      pullScripts(server.client, agentDir, scripts, false),
    ).rejects.toMatchObject({ code: "merge_conflict", exitCode: 22 });
    expect(await read("repo/agent/agent.yaml")).toBe("mine");

    await pullScripts(server.client, agentDir, scripts, true);
    expect(await read("repo/agent/agent.yaml")).toBe("laminar");
    expect(await read("repo/agent/notes.md")).toBe("notes");
  });

  void it("pulls only the scripts for <agent>", async () => {
    await agentInLaminar("laminar");
    await handleEvalPull("agent", { dir: path.join(root, "repo") });
    expect(await read("repo/agent/agent.yaml")).toBe("laminar");
    await expect(read("repo/agent/task_sets/s/a/task.toml")).rejects.toThrow();
  });

  void it("pulls every task set for --all, keeping local scripts", async () => {
    await agentInLaminar("laminar");
    await write("repo/agent/agent.yaml", "mine");
    await handleEvalPull("agent", { dir: path.join(root, "repo"), all: true });
    expect(await read("repo/agent/agent.yaml")).toBe("mine");
    expect(await read("repo/agent/task_sets/s/a/task.toml")).toBe(toml("a1"));
  });

  void it("fills in the scripts for --all when there are none locally", async () => {
    await agentInLaminar("laminar");
    await handleEvalPull("agent", { dir: path.join(root, "repo"), all: true });
    expect(await read("repo/agent/agent.yaml")).toBe("laminar");
    expect(await read("repo/agent/task_sets/s/a/task.toml")).toBe(toml("a1"));
  });
});
