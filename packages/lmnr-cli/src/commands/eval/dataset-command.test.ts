import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEvalClient } from "./client";
import {
  handleDatasetPull,
  handleDatasetPush,
  pullRunTasks,
} from "./dataset-command";
import { readDatasetState } from "./dataset-state";
import { hashTaskDir } from "./task-hash";
import { readTasksToml, writeTasksToml } from "./tasks-toml";

vi.mock("./client", () => ({ buildEvalClient: vi.fn() }));

const apiError = (status: number, code: string) =>
  Object.assign(new Error(`${status} ${code}`), {
    name: "LaminarApiError",
    status,
    code,
  });

/**
 * An in-memory Laminar following the eval datasets contract: a version
 * counts once its index is uploaded, latest = last pushed (or uploaded).
 */
const fakeLaminar = () => {
  let clock = 0;
  type Version = { archive: Uint8Array; at: number; indexed: boolean };
  const store = new Map<string, Map<string, Map<string, Version>>>();
  const versionsOf = (dataset: string, task: string) => {
    const tasks = store.get(dataset) ?? new Map<string, Map<string, Version>>();
    store.set(dataset, tasks);
    const versions = tasks.get(task) ?? new Map<string, Version>();
    tasks.set(task, versions);
    return versions;
  };
  const counted = (dataset: string, task: string) =>
    [...(store.get(dataset)?.get(task)?.entries() ?? [])].filter(
      ([, v]) => v.indexed,
    );
  const latest = (dataset: string, task: string) =>
    counted(dataset, task).sort(
      ([ha, a], [hb, b]) => b.at - a.at || (hb > ha ? 1 : -1),
    )[0];
  const has = (dataset: string, task: string, hash: string) =>
    store.get(dataset)?.get(task)?.get(hash)?.indexed === true;
  const calls: string[] = [];

  const evalDatasets = {
    get: async (dataset: string) => {
      calls.push(`get ${dataset}`);
      const tasks = [...(store.get(dataset)?.keys() ?? [])]
        .filter((task) => counted(dataset, task).length > 0)
        .sort();
      if (tasks.length === 0) return null;
      return {
        id: dataset,
        createdAt: "",
        tasks: tasks.map((id) => ({
          id,
          hash: latest(dataset, id)[0],
          createdAt: "",
        })),
      };
    },
    missingVersions: async (
      dataset: string,
      versions: { task: string; hash: string }[],
    ) => versions.filter((v) => !has(dataset, v.task, v.hash)),
    uploadVersion: async (
      dataset: string,
      task: string,
      hash: string,
      archive: Uint8Array,
    ) => {
      calls.push(`upload ${dataset}/${task}`);
      versionsOf(dataset, task).set(hash, { archive, at: 0, indexed: false });
    },
    uploadVersionIndex: async (dataset: string, task: string, hash: string) => {
      const v = versionsOf(dataset, task).get(hash);
      if (!v) throw apiError(404, "archive_not_found");
      v.indexed = true;
      v.at = ++clock;
    },
    downloadVersion: async (dataset: string, task: string, hash: string) => {
      calls.push(`download ${dataset}/${task}`);
      const v = store.get(dataset)?.get(task)?.get(hash);
      if (!v?.indexed) throw apiError(404, "version_not_found");
      return new Blob([v.archive as Uint8Array<ArrayBuffer>]).stream();
    },
    push: async (
      dataset: string,
      tasks: { task: string; hash: string; base: string | null }[],
    ) => {
      calls.push(`push ${dataset} ${tasks.map((t) => t.task).join(",")}`);
      const missing = tasks.filter((t) => !has(dataset, t.task, t.hash));
      if (missing.length > 0) return { status: "versions_missing", missing };
      const moved = tasks
        .filter(({ task, hash, base }) => {
          const versions = counted(dataset, task);
          if (base === null) return versions.some(([h]) => h !== hash);
          const baseAt = versions.find(([h]) => h === base)?.[1].at;
          if (baseAt === undefined) return true;
          return versions.some(
            ([h, v]) => h !== base && h !== hash && v.at > baseAt,
          );
        })
        .map(({ task }) => ({ task, latest: latest(dataset, task)[0] }));
      if (moved.length > 0) return { status: "moved", moved };
      for (const t of tasks)
        versionsOf(dataset, t.task).get(t.hash)!.at = ++clock;
      return { status: "pushed", tasks: [] };
    },
  };
  return { client: { evalDatasets } as unknown as LaminarClient, calls };
};

let root: string;
let laminar: ReturnType<typeof fakeLaminar>;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};
const read = (rel: string) => readFile(path.join(root, rel), "utf8");
const opts = (dir: string, extra: object = {}) => ({
  dir: path.join(root, dir),
  ...extra,
});

/** A fresh `evals/support` dataset with two local tasks. */
const writeDataset = async (dir = "evals") => {
  await write(`${dir}/support/harbor.yaml`, "datasets:\n  - path: tasks\n");
  await write(`${dir}/support/tasks/refund/task.toml`, "[task]\n");
  await write(`${dir}/support/tasks/complaint/task.toml`, "[task]\n");
  await write(`${dir}/support/tasks/complaint/data.txt`, "v1");
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-dataset-"));
  laminar = fakeLaminar();
  vi.mocked(buildEvalClient).mockResolvedValue(laminar.client);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

void describe("eval dataset push / pull", () => {
  void it("pushes local tasks, then pulls them into another checkout", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));

    const pins = await readTasksToml(path.join(root, "evals/support"));
    expect(Object.keys(pins!)).toEqual(["complaint", "refund"]);
    expect(pins!.refund).toBe(
      await hashTaskDir(path.join(root, "evals/support/tasks/refund")),
    );
    expect(await readDatasetState(path.join(root, "evals/support"))).toEqual(
      pins,
    );
    expect(await read("evals/.gitignore")).toContain("*/tasks/\n");
    expect(laminar.calls.filter((c) => c.startsWith("upload"))).toHaveLength(2);

    // Another checkout: harbor.yaml + tasks.toml, no tasks/.
    await write("clone/support/harbor.yaml", "datasets:\n  - path: tasks\n");
    await cp(
      path.join(root, "evals/support/tasks.toml"),
      path.join(root, "clone/support/tasks.toml"),
    );
    await handleDatasetPull([], opts("clone"));
    expect(await read("clone/support/tasks/complaint/data.txt")).toBe("v1");
    expect(await readDatasetState(path.join(root, "clone/support"))).toEqual(
      pins,
    );

    // Nothing changed: a second push uploads and pushes nothing.
    laminar.calls.length = 0;
    await handleDatasetPush(["support"], opts("clone"));
    expect(laminar.calls).toEqual(["get support"]);
  });

  void it("refuses to overwrite local edits without --force (exit 22)", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");
    const pinned = (await readTasksToml(ds))!.complaint;

    // A teammate pushes v2 of complaint; here, it is edited locally.
    await cp(ds, path.join(root, "other/support"), { recursive: true });
    await write("other/support/tasks/complaint/data.txt", "v2");
    await handleDatasetPush([], opts("other"));
    await write("evals/support/tasks/complaint/data.txt", "mine");

    await expect(
      handleDatasetPull(["support"], opts("evals", { latest: true })),
    ).rejects.toMatchObject({
      code: "local_edits",
      exitCode: 22,
      message: expect.stringContaining("support/complaint"),
    });
    await expect(
      handleDatasetPull(
        ["support"],
        opts("evals", { latest: true, dryRun: true }),
      ),
    ).rejects.toMatchObject({ exitCode: 22 });
    // Nothing was written.
    expect(await read("evals/support/tasks/complaint/data.txt")).toBe("mine");
    expect((await readTasksToml(ds))!.complaint).toBe(pinned);

    await handleDatasetPull(
      ["support"],
      opts("evals", { latest: true, force: true }),
    );
    expect(await read("evals/support/tasks/complaint/data.txt")).toBe("v2");
    expect((await readTasksToml(ds))!.complaint).not.toBe(pinned);
  });

  void it("refuses a push whose pin moved in Laminar (exit 23) until pulled", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(
      path.join(root, "evals/support"),
      path.join(root, "other/support"),
      { recursive: true },
    );
    await write("other/support/tasks/refund/task.toml", "[task]\nv = 2\n");
    await handleDatasetPush([], opts("other"));

    // Unedited here, but Laminar moved: refused, dry run too.
    await write("evals/support/tasks/complaint/data.txt", "v3");
    for (const dryRun of [true, false]) {
      await expect(
        handleDatasetPush([], opts("evals", { dryRun })),
      ).rejects.toMatchObject({
        code: "pin_moved",
        exitCode: 23,
        message: expect.stringContaining(
          "eval dataset pull support --dir " +
            `${path.join(root, "evals")} --latest --task refund`,
        ),
      });
    }
    expect(laminar.calls.filter((c) => c.startsWith("push support"))).toEqual([
      "push support complaint,refund",
      "push support refund",
    ]);

    await handleDatasetPull(
      ["support"],
      opts("evals", { latest: true, task: ["refund"] }),
    );
    await handleDatasetPush([], opts("evals"));
    const pins = (await readTasksToml(path.join(root, "evals/support")))!;
    expect(pins.complaint).toBe(
      await hashTaskDir(path.join(root, "evals/support/tasks/complaint")),
    );
  });

  void it("turns the server's 409 moved into exit 23", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await write("evals/support/tasks/refund/task.toml", "[task]\nv = 3\n");
    const push = vi
      .spyOn(
        (laminar.client as unknown as { evalDatasets: { push: () => unknown } })
          .evalDatasets,
        "push",
      )
      .mockResolvedValue({
        status: "moved",
        moved: [{ task: "refund", latest: "f".repeat(64) }],
      });
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "pin_moved",
      message: expect.stringMatching(/support\/refund: Laminar's latest/),
    });
    expect(push).toHaveBeenCalled();
  });

  void it("removes tasks unpinned upstream and unpins tasks deleted here", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");

    // Deleting a pulled task's dir unpins it on push.
    await rm(path.join(ds, "tasks/refund"), { recursive: true });
    await handleDatasetPush([], opts("evals"));
    expect(Object.keys((await readTasksToml(ds))!)).toEqual(["complaint"]);

    // A pin removed from tasks.toml (e.g. by git) removes the dir on pull.
    await writeTasksToml(ds, {});
    await handleDatasetPull([], opts("evals", { dryRun: true, json: true }));
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(true);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(false);
    expect(await readDatasetState(ds)).toEqual({});
  });

  void it("creates a named dataset folder and pulls its latest tasks", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await handleDatasetPull(["support"], opts("fresh"));
    expect(await read("fresh/support/tasks/complaint/data.txt")).toBe("v1");
    expect(await readTasksToml(path.join(root, "fresh/support"))).toEqual(
      await readTasksToml(path.join(root, "evals/support")),
    );
    expect(await read("fresh/.gitignore")).toContain("*/tasks/");

    await expect(
      handleDatasetPull(["nope"], opts("fresh")),
    ).rejects.toMatchObject({ code: "dataset_not_found" });
    await expect(
      handleDatasetPull(["../bad"], opts("fresh")),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });

  void it("skips folders Laminar doesn't have when they have no tasks.toml", async () => {
    await write("evals/local-only/harbor.yaml", "");
    await write("evals/local-only/tasks/a/task.toml", "");
    await handleDatasetPull([], opts("evals"));
    expect(laminar.calls).toEqual(["get local-only"]);
  });

  void it("fails clearly on a pinned version Laminar doesn't have", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await writeTasksToml(path.join(root, "evals/support"), {
      refund: "e".repeat(64),
    });
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
      code: "version_not_found",
      message: expect.stringContaining("refund@eeeeeeeeeeee"),
    });
  });

  void it("explains a deployment without storage", async () => {
    await writeDataset();
    vi.spyOn(
      (laminar.client as unknown as { evalDatasets: { get: () => unknown } })
        .evalDatasets,
      "get",
    ).mockRejectedValue(apiError(501, "storage_not_configured"));
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "storage_not_configured",
      message: expect.stringMatching(/no storage for eval datasets/),
    });
  });
});

void describe("pullRunTasks", () => {
  void it("pulls missing and re-pinned tasks; edited ones run as they are", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");
    const evalsDir = path.join(root, "evals");
    const build = vi.fn(async () => laminar.client);

    // Missing task: pulled.
    await rm(path.join(ds, "tasks/refund"), { recursive: true });
    await pullRunTasks(evalsDir, ["support"], undefined, {}, build);
    expect(existsSync(path.join(ds, "tasks/refund/task.toml"))).toBe(true);

    // Edited task: left alone, no client needed.
    await write("evals/support/tasks/complaint/data.txt", "mine");
    build.mockClear();
    await pullRunTasks(evalsDir, ["support"], undefined, {}, build);
    expect(await read("evals/support/tasks/complaint/data.txt")).toBe("mine");
    expect(build).not.toHaveBeenCalled();

    // Re-pinned (e.g. git pull) and unedited: pulled.
    await cp(ds, path.join(root, "other/support"), { recursive: true });
    await write("other/support/tasks/refund/task.toml", "[task]\nv = 2\n");
    await handleDatasetPush([], opts("other", { task: ["refund"] }));
    await cp(
      path.join(root, "other/support/tasks.toml"),
      path.join(ds, "tasks.toml"),
    );
    // Laminar unreachable, but the task is on disk: the run goes on.
    const down = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await pullRunTasks(evalsDir, ["support"], undefined, {}, down);
    expect(await read("evals/support/tasks/refund/task.toml")).toBe("[task]\n");
    await pullRunTasks(evalsDir, ["support"], ["ref*"], {}, build);
    expect(await read("evals/support/tasks/refund/task.toml")).toBe(
      "[task]\nv = 2\n",
    );

    // A missing task can't run without Laminar.
    await rm(path.join(ds, "tasks/refund"), { recursive: true });
    await expect(
      pullRunTasks(evalsDir, ["support"], undefined, {}, down),
    ).rejects.toThrow(/fetch failed/);
  });
});
