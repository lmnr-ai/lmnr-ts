import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatPullPlan,
  formatPushPlan,
  prepareRunDatasets,
  pullDatasets,
  pushDatasets,
} from "./dataset-sync";
import { hashLocalTasks, listTasks } from "./tasks";
import {
  readState,
  readTasksToml,
  writeState,
  writeTasksToml,
} from "./tasks-toml";

let root: string;
let evals: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(evals, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const apiError = (status: number, message: string, missing?: string[]) =>
  Object.assign(new Error(`${status} ${message}`), { status, missing });

/** An in-memory Laminar: per-task versions, the latest by push time. */
const fakeLaminar = () => {
  const blobs = new Map<string, Uint8Array>();
  /** `<dataset>/<task>` → hash → when it last became the latest. */
  const versions = new Map<string, Map<string, number>>();
  const datasets = new Set<string>();
  let clock = 0;
  const key = (dataset: string, task: string) => `${dataset}/${task}`;
  const has = (dataset: string, task: string, hash: string) =>
    versions.get(key(dataset, task))?.has(hash) ?? false;
  const latest = (dataset: string) =>
    Object.fromEntries(
      [...versions.entries()]
        .filter(([k]) => k.startsWith(`${dataset}/`))
        .map(([k, byHash]) => [
          k.slice(dataset.length + 1),
          [...byHash.entries()].sort((a, b) => b[1] - a[1])[0][0],
        ]),
    ) as Record<string, string>;
  const evalDatasets = {
    listTasks: vi.fn(async (dataset: string) => {
      if (!datasets.has(dataset)) throw apiError(404, "Dataset not found");
      return Object.entries(latest(dataset))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, hash]) => ({ name, hash, createdAt: "2026-11-18" }));
    }),
    missingTasks: vi.fn(
      async (dataset: string, tasks: Record<string, string>) =>
        Object.keys(tasks).filter((t) => !has(dataset, t, tasks[t])),
    ),
    uploadTask: vi.fn(
      async (dataset: string, task: string, hash: string, a: Uint8Array) => {
        blobs.set(`${key(dataset, task)}/${hash}`, a);
      },
    ),
    uploadTaskIndex: vi.fn(
      async (dataset: string, task: string, hash: string) => {
        if (!blobs.has(`${key(dataset, task)}/${hash}`)) {
          throw apiError(404, "Archive not uploaded");
        }
        datasets.add(dataset);
        const byHash = versions.get(key(dataset, task)) ?? new Map();
        if (!byHash.has(hash)) byHash.set(hash, clock++);
        versions.set(key(dataset, task), byHash);
      },
    ),
    pushTasks: vi.fn(
      async (
        dataset: string,
        tasks: Record<string, string>,
        base?: Record<string, string | null>,
      ) => {
        // The server's base check: the newest version other than the pushed one.
        const moved = Object.keys(tasks).filter((t) => {
          const other = [...(versions.get(key(dataset, t)) ?? new Map())]
            .filter(([hash]) => hash !== tasks[t])
            .sort((a, b) => b[1] - a[1])[0]?.[0];
          return base && other !== undefined && other !== (base[t] ?? null);
        });
        if (moved.length > 0) {
          throw Object.assign(apiError(409, "Pull them first"), { moved });
        }
        const missing = Object.keys(tasks).filter(
          (t) => !has(dataset, t, tasks[t]),
        );
        if (missing.length > 0) {
          throw apiError(409, "Task versions not uploaded", missing);
        }
        for (const [task, hash] of Object.entries(tasks)) {
          versions.get(key(dataset, task))!.set(hash, clock++);
        }
        return Object.entries(tasks).map(([name, hash]) => ({
          name,
          hash,
          createdAt: "2026-11-18",
        }));
      },
    ),
    downloadTask: vi.fn(async (dataset: string, task: string, hash: string) => {
      const blob = blobs.get(`${key(dataset, task)}/${hash}`);
      if (!blob || !has(dataset, task, hash)) {
        throw apiError(404, "Task version not found");
      }
      return new Blob([blob as Uint8Array<ArrayBuffer>]).stream();
    }),
  };
  const client = { evalDatasets } as unknown as LaminarClient;
  const getClient = vi.fn(async () => client);
  return { evalDatasets, getClient, latest };
};

const diskHashes = async (folder: string) =>
  hashLocalTasks(await listTasks(path.join(evals, folder)));

const toml = (folder: string) => readTasksToml(path.join(evals, folder));
const state = (folder: string) => readState(path.join(evals, folder));

/** `support` with two tasks. */
const writeSupport = async () => {
  await write("support/harbor.yaml", "agents: []\n");
  await write("support/tasks/refund/task.toml", "[task]\nname = 'refund'\n");
  await write("support/tasks/refund/instruction.md", "Refund it.");
  await write("support/tasks/greet/task.toml", "[task]\nname = 'greet'\n");
};

/** A clone of the repo elsewhere: `evals/` minus every `tasks/` (gitignored). */
const cloneEvals = async (): Promise<string> => {
  const other = path.join(root, "clone", "evals");
  await cp(evals, other, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("tasks"),
  });
  return other;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-sync-"));
  evals = path.join(root, "evals");
  process.env.LMNR_CACHE_DIR = path.join(root, "cache");
});

afterEach(async () => {
  delete process.env.LMNR_CACHE_DIR;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

void describe("eval dataset push", () => {
  void it("pins every task, then only pushes what changed", async () => {
    await writeSupport();
    const server = fakeLaminar();

    const [first] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(first).toEqual({
      dataset: "support",
      added: ["greet", "refund"],
      changed: [],
      removed: [],
      unchanged: 0,
      uploaded: ["greet", "refund"],
      dryRun: false,
    });
    const v1 = await diskHashes("support");
    expect(await toml("support")).toEqual(v1);
    expect(await state("support")).toEqual({ tasks: v1, localHashes: {} });
    expect(server.latest("support")).toEqual(v1);
    expect(await readFile(path.join(evals, ".gitignore"), "utf8")).toBe(
      "*/tasks/\n",
    );

    server.getClient.mockClear();
    const [noop] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(noop).toMatchObject({ added: [], changed: [], unchanged: 2 });
    expect(server.getClient).not.toHaveBeenCalled();

    await write("support/tasks/refund/instruction.md", "Refund it twice.");
    const [edit] = await pushDatasets(evals, ["support"], {}, server.getClient);
    expect(edit).toMatchObject({
      changed: ["refund"],
      uploaded: ["refund"],
      unchanged: 1,
    });
    const v2 = await diskHashes("support");
    expect(v2.refund).not.toBe(v1.refund);
    expect(await toml("support")).toEqual(v2);
    expect(server.latest("support")).toEqual(v2);
    expect(server.evalDatasets.uploadTask).toHaveBeenCalledTimes(3);
  });

  void it("makes a pushed older version the latest again without uploading it", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const v1 = await diskHashes("support");
    await write("support/tasks/refund/instruction.md", "v2");
    await pushDatasets(evals, undefined, {}, server.getClient);

    await write("support/tasks/refund/instruction.md", "Refund it.");
    const [revert] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(revert).toMatchObject({ changed: ["refund"], uploaded: [] });
    expect(server.latest("support")).toEqual(v1);
  });

  void it("plans with --dry-run and --task without writing anything", async () => {
    await writeSupport();
    const server = fakeLaminar();

    const plan = await pushDatasets(
      evals,
      undefined,
      { dryRun: true, tasks: ["ref*"] },
      server.getClient,
    );
    expect(plan).toEqual([
      {
        dataset: "support",
        added: ["refund"],
        changed: [],
        removed: [],
        unchanged: 0,
        uploaded: [],
        dryRun: true,
      },
    ]);
    expect(formatPushPlan(plan)).toBe(
      "support: 1 added, 0 changed, 0 removed, 0 unchanged\n  + refund\n",
    );
    // Only read: what Laminar has of the dataset (nothing yet).
    expect(server.evalDatasets.uploadTask).not.toHaveBeenCalled();
    expect(server.evalDatasets.pushTasks).not.toHaveBeenCalled();
    expect(await toml("support")).toBeNull();
    expect(existsSync(path.join(evals, ".gitignore"))).toBe(false);

    await pushDatasets(evals, undefined, { tasks: ["ref*"] }, server.getClient);
    expect(Object.keys((await toml("support"))!)).toEqual(["refund"]);
  });

  void it("drops deleted tasks from tasks.toml, keeping ones never pulled here", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const pins = (await toml("support"))!;
    // Pinned by someone else, never pulled to this disk.
    await writeTasksToml(path.join(evals, "support"), {
      ...pins,
      other: "f".repeat(64),
    });
    await rm(path.join(evals, "support/tasks/greet"), { recursive: true });

    const [result] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(result).toMatchObject({ removed: ["greet"], unchanged: 1 });
    expect(await toml("support")).toEqual({
      refund: pins.refund,
      other: "f".repeat(64),
    });
    expect((await state("support")).tasks).toEqual({ refund: pins.refund });
    // Laminar keeps the task.
    expect(server.latest("support").greet).toBe(pins.greet);
  });

  void it("uploads what the server still misses when pushing, once", async () => {
    await writeSupport();
    const server = fakeLaminar();
    server.evalDatasets.missingTasks.mockResolvedValueOnce([]);

    const [result] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(result.uploaded).toEqual(["greet", "refund"]);
    expect(server.evalDatasets.pushTasks).toHaveBeenCalledTimes(2);
  });

  void it("refuses to push unedited tasks older than tasks.toml pins", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const v1 = await diskHashes("support");
    // Someone else pushes a new refund; its tasks.toml arrives through git.
    await write("support/tasks/refund/instruction.md", "Theirs.");
    await pushDatasets(evals, undefined, {}, server.getClient);
    await write("support/tasks/refund/instruction.md", "Refund it.");
    await writeState(path.join(evals, "support"), {
      tasks: v1,
      localHashes: {},
    });
    // And a new task of ours.
    await write("support/tasks/new/task.toml", "[task]\n");

    for (const dryRun of [false, true]) {
      await expect(
        pushDatasets(evals, undefined, { dryRun }, server.getClient),
      ).rejects.toMatchObject({
        code: "tasks_behind_lock",
        message: expect.stringMatching(/support: refund\n/),
      });
    }
    await pullDatasets(evals, undefined, {}, server.getClient);
    expect(
      await readFile(
        path.join(evals, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("Theirs.");
    const [result] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(result).toMatchObject({ added: ["new"], changed: [] });
  });

  void it("refuses to push over a version pushed to Laminar since the pull", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    // A teammate pushes a new refund from their clone; nothing reaches git yet.
    const theirs = await cloneEvals();
    await pullDatasets(theirs, undefined, {}, server.getClient);
    await writeFile(
      path.join(theirs, "support/tasks/refund/instruction.md"),
      "Theirs.",
    );
    await pushDatasets(theirs, undefined, {}, server.getClient);
    const latest = server.latest("support").refund;

    // Ours edits refund too, and adds a task named like one only they have.
    await write("support/tasks/refund/instruction.md", "Ours.");
    for (const dryRun of [false, true]) {
      await expect(
        pushDatasets(evals, undefined, { dryRun }, server.getClient),
      ).rejects.toMatchObject({
        code: "tasks_behind_lock",
        message: expect.stringMatching(/support: refund\n/),
      });
    }
    expect(server.latest("support").refund).toBe(latest);

    // Pull their version, re-apply the edit, push.
    await pullDatasets(
      evals,
      undefined,
      { latest: true, force: true, tasks: ["refund"] },
      server.getClient,
    );
    await write("support/tasks/refund/instruction.md", "Ours.");
    const [result] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(result).toMatchObject({ changed: ["refund"] });
  });

  void it("is refused by Laminar when a version lands after its check", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const before = server.latest("support");
    const theirs = await cloneEvals();
    await pullDatasets(theirs, undefined, {}, server.getClient);
    await writeFile(
      path.join(theirs, "support/tasks/refund/instruction.md"),
      "Theirs.",
    );
    await pushDatasets(theirs, undefined, {}, server.getClient);
    // Our check read Laminar before their push.
    server.evalDatasets.listTasks.mockResolvedValueOnce(
      Object.entries(before).map(([name, hash]) => ({
        name,
        hash,
        createdAt: "2026-11-18",
      })),
    );
    await write("support/tasks/refund/instruction.md", "Ours.");

    await expect(
      pushDatasets(evals, undefined, {}, server.getClient),
    ).rejects.toMatchObject({
      code: "tasks_behind_lock",
      message: expect.stringMatching(/support: refund\n/),
    });
    expect(await toml("support")).toEqual(before);
  });

  void it("skips invalid folders without names, and keeps a linked task's pin", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    await write("_scratch/tasks/a/task.toml", "[task]\n");
    await rename(
      path.join(evals, "support/tasks/greet"),
      path.join(root, "greet"),
    );
    await symlink(
      path.join(root, "greet"),
      path.join(evals, "support/tasks/greet"),
    );

    const results = await pushDatasets(evals, undefined, {}, server.getClient);

    expect(results.map((r) => r.dataset)).toEqual(["support"]);
    expect(results[0]).toMatchObject({ removed: [] });
    expect(Object.keys((await toml("support")) ?? {})).toContain("greet");
  });

  void it("rejects bad names and a missing tasks/ before uploading", async () => {
    await writeSupport();
    await write("support/tasks/bad name/task.toml", "[task]\n");
    const server = fakeLaminar();
    await expect(
      pushDatasets(evals, undefined, {}, server.getClient),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/bad name/),
    });
    await expect(
      pushDatasets(evals, ["nope"], {}, server.getClient),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/doesn't exist/),
    });
    await write("bad set/tasks/a/task.toml", "[task]\n");
    await expect(
      pushDatasets(evals, ["bad set"], {}, server.getClient),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
    expect(server.getClient).not.toHaveBeenCalled();
  });
});

void describe("eval dataset pull", () => {
  void it("gets the pinned tasks into a fresh clone, from the cache next time", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const pins = await diskHashes("support");
    const clone = await cloneEvals();

    const [pulled] = await pullDatasets(clone, undefined, {}, server.getClient);
    expect(pulled).toEqual({
      dataset: "support",
      added: ["greet", "refund"],
      changed: [],
      removed: [],
      unchanged: 0,
      localEdits: [],
      tasksTomlUpdated: false,
      dryRun: false,
    });
    expect(
      await hashLocalTasks(await listTasks(path.join(clone, "support"))),
    ).toEqual(pins);
    expect(await readState(path.join(clone, "support"))).toEqual({
      tasks: pins,
      localHashes: {},
    });
    expect(await readFile(path.join(clone, ".gitignore"), "utf8")).toBe(
      "*/tasks/\n",
    );
    expect(server.evalDatasets.downloadTask).toHaveBeenCalledTimes(2);

    await rm(path.join(clone, "support/tasks"), { recursive: true });
    await pullDatasets(clone, undefined, {}, server.getClient);
    expect(server.evalDatasets.downloadTask).toHaveBeenCalledTimes(2);
    // Up to date: no listTasks, nothing downloaded.
    server.evalDatasets.listTasks.mockClear();
    const [again] = await pullDatasets(clone, undefined, {}, server.getClient);
    expect(again).toMatchObject({ added: [], unchanged: 2 });
    expect(server.evalDatasets.listTasks).not.toHaveBeenCalled();
  });

  void it("creates a named dataset's folder and pins Laminar's latest", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const pins = await diskHashes("support");
    const empty = path.join(root, "empty", "evals");

    const plan = await pullDatasets(
      empty,
      ["support"],
      { dryRun: true },
      server.getClient,
    );
    expect(formatPullPlan(plan)).toBe(
      "support: 2 added, 0 changed, 0 removed, 0 unchanged; tasks.toml " +
        "would be updated\n  + greet\n  + refund\n",
    );
    expect(existsSync(empty)).toBe(false);

    await pullDatasets(empty, ["support"], {}, server.getClient);
    expect(await readTasksToml(path.join(empty, "support"))).toEqual(pins);
    expect(
      await hashLocalTasks(await listTasks(path.join(empty, "support"))),
    ).toEqual(pins);
  });

  void it("--latest moves pins forward, keeping pins Laminar doesn't have", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const clone = await cloneEvals();
    await pullDatasets(clone, undefined, {}, server.getClient);
    await write("support/tasks/refund/instruction.md", "v2");
    await pushDatasets(evals, undefined, {}, server.getClient);
    const local = "e".repeat(64);
    const pins = (await readTasksToml(path.join(clone, "support")))!;
    await writeTasksToml(path.join(clone, "support"), { ...pins, local });

    const [result] = await pullDatasets(
      clone,
      undefined,
      { latest: true, tasks: ["refund"] },
      server.getClient,
    );
    expect(result).toMatchObject({
      changed: ["refund"],
      tasksTomlUpdated: true,
    });
    expect(await readTasksToml(path.join(clone, "support"))).toEqual({
      ...(await diskHashes("support")),
      local,
    });
    expect(
      await readFile(
        path.join(clone, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("v2");
  });

  void it("refuses to overwrite or delete local edits, in any dataset, unless forced", async () => {
    await writeSupport();
    await write("billing/harbor.yaml", "agents: []\n");
    await write("billing/tasks/invoice/task.toml", "[task]\n");
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const v1 = await diskHashes("support");
    await write("support/tasks/refund/instruction.md", "v2");
    await pushDatasets(evals, undefined, {}, server.getClient);
    // Back to v1 in tasks.toml (a `git checkout`), with edits on top.
    await writeTasksToml(path.join(evals, "support"), v1);
    await write("support/tasks/refund/instruction.md", "my edit");
    await writeTasksToml(path.join(evals, "billing"), {});
    const before = await diskHashes("billing");

    await expect(
      pullDatasets(evals, undefined, {}, server.getClient),
    ).rejects.toMatchObject({
      code: "local_changes",
      message: expect.stringMatching(/support: refund\n/),
    });
    expect(await diskHashes("billing")).toEqual(before);

    const [, support] = await pullDatasets(
      evals,
      undefined,
      { force: true, dryRun: true },
      server.getClient,
    );
    expect(support).toMatchObject({
      changed: ["refund"],
      localEdits: ["refund"],
    });
    expect(
      await readFile(
        path.join(evals, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("my edit");

    const [billing] = await pullDatasets(
      evals,
      undefined,
      { force: true },
      server.getClient,
    );
    expect(billing).toMatchObject({ removed: ["invoice"] });
    expect(await diskHashes("support")).toEqual(v1);
    expect(await diskHashes("billing")).toEqual({});
  });

  void it("deletes tasks tasks.toml no longer pins, and leaves new local ones", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const { refund } = (await toml("support"))!;
    await writeTasksToml(path.join(evals, "support"), { refund });
    await write("support/tasks/mine/task.toml", "[task]\n");

    const [result] = await pullDatasets(evals, undefined, {}, server.getClient);
    expect(result).toMatchObject({ removed: ["greet"], unchanged: 1 });
    expect(Object.keys(await diskHashes("support")).sort()).toEqual([
      "mine",
      "refund",
    ]);
    expect((await state("support")).tasks).toEqual({ refund });
  });

  void it("fails for a dataset Laminar doesn't have, and skips unpushed folders", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await expect(
      pullDatasets(evals, ["support"], {}, server.getClient),
    ).rejects.toMatchObject({ code: "dataset_not_found" });
    expect(await pullDatasets(evals, undefined, {}, server.getClient)).toEqual(
      [],
    );
    await expect(
      pullDatasets(evals, ["../x"], {}, server.getClient),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });
});

void describe("tasks/ on a disk without exec bits", () => {
  void it("counts synced tasks by their recorded disk hash, edits as edits", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const dir = path.join(evals, "support");
    const pins = (await readTasksToml(dir))!;
    // What a Windows pull records: modes there come from extensions, so a
    // synced task can hash differently on disk than in tasks.toml.
    await chmod(path.join(dir, "tasks/refund/instruction.md"), 0o755);
    const disk = await diskHashes("support");
    await writeState(dir, {
      tasks: pins,
      localHashes: { refund: disk.refund },
    });

    const [noop] = await pushDatasets(evals, undefined, {}, server.getClient);
    expect(noop).toMatchObject({ changed: [], unchanged: 2 });
    const [run] = await prepareRunDatasets(
      evals,
      ["support"],
      undefined,
      server.getClient,
    );
    expect(run.taskHashes).toEqual(pins);

    await write("support/tasks/refund/instruction.md", "edited");
    const [edited] = await pushDatasets(
      evals,
      undefined,
      { dryRun: true },
      server.getClient,
    );
    expect(edited).toMatchObject({ changed: ["refund"] });
  });
});

void describe("eval run: syncing", () => {
  void it("pulls missing and outdated tasks, runs edited ones as they are", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    const v1 = await diskHashes("support");
    const clone = await cloneEvals();

    // A fresh clone: every pinned task is pulled.
    const [fresh] = await prepareRunDatasets(
      clone,
      ["support"],
      undefined,
      server.getClient,
    );
    expect(fresh).toEqual({ path: "support", taskHashes: v1 });

    // tasks.toml moves (git pull) for both tasks; refund is edited here.
    await write("support/tasks/refund/instruction.md", "v2");
    await write("support/tasks/greet/task.toml", "[task]\nname = 'hi'\n");
    await pushDatasets(evals, undefined, {}, server.getClient);
    const v2 = await diskHashes("support");
    await cp(
      path.join(evals, "support/tasks.toml"),
      path.join(clone, "support/tasks.toml"),
    );
    await writeFile(
      path.join(clone, "support/tasks/refund/instruction.md"),
      "mine",
    );

    const [run] = await prepareRunDatasets(
      clone,
      ["support"],
      ["*"],
      server.getClient,
    );
    expect(run.taskHashes.greet).toBe(v2.greet);
    expect(run.taskHashes.refund).not.toBe(v2.refund);
    expect(run.taskHashes.refund).not.toBe(v1.refund);
    expect(
      await readFile(
        path.join(clone, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("mine");

    // --task limits the hashes to the run's tasks.
    const [greet] = await prepareRunDatasets(
      clone,
      ["support"],
      ["gr*"],
      server.getClient,
    );
    expect(greet.taskHashes).toEqual({ greet: v2.greet });
  });

  void it("runs a dataset without tasks.toml as is, and fails without tasks/ either", async () => {
    await writeSupport();
    const server = fakeLaminar();
    const [run] = await prepareRunDatasets(
      evals,
      ["support"],
      undefined,
      server.getClient,
    );
    expect(run.taskHashes).toEqual(await diskHashes("support"));
    expect(server.getClient).not.toHaveBeenCalled();

    await write("empty/harbor.yaml", "agents: []\n");
    await expect(
      prepareRunDatasets(evals, ["empty"], undefined, server.getClient),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });

  void it("leaves a linked task alone, and drops staging an interrupted pull left", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, undefined, {}, server.getClient);
    // A dev copy linked in place of a pinned task.
    await rename(
      path.join(evals, "support/tasks/greet"),
      path.join(root, "greet"),
    );
    await symlink(
      path.join(root, "greet"),
      path.join(evals, "support/tasks/greet"),
    );
    await write(
      "support/tasks/.refund.lmnr-tmp-0123abcd/task.toml",
      "[task]\n",
    );

    await expect(
      pullDatasets(evals, undefined, {}, server.getClient),
    ).rejects.toMatchObject({ code: "local_changes" });
    await prepareRunDatasets(evals, ["support"], undefined, server.getClient);
    expect(
      (await lstat(path.join(evals, "support/tasks/greet"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      existsSync(path.join(evals, "support/tasks/.refund.lmnr-tmp-0123abcd")),
    ).toBe(false);

    await pullDatasets(evals, undefined, { force: true }, server.getClient);
    expect(
      (await lstat(path.join(evals, "support/tasks/greet"))).isDirectory(),
    ).toBe(true);
  });
});
