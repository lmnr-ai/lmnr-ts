import { existsSync } from "node:fs";
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

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEvalClient } from "./client";
import {
  handleDatasetPull,
  handleDatasetPush,
  pullRunTasks,
} from "./dataset-command";
import { readDatasetState } from "./dataset-state";
import { readDatasetToml, writeDatasetToml } from "./dataset-toml";
import { hashTaskDir } from "./task-hash";

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

const DS = "acme/support";

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
const pinsOf = async (dir: string) =>
  (await readDatasetToml(path.join(root, dir)))?.pins;
const setPins = async (dir: string, pins: Record<string, string>) => {
  const manifest = await readDatasetToml(path.join(root, dir));
  await writeDatasetToml(path.join(root, dir), manifest!, pins);
};
const taskToml = (name: string, extra = "") =>
  `[task]\nname = "${name}"\n${extra}`;

/** A fresh `evals/support` dataset (acme/support) with two local tasks. */
const writeDataset = async (dir = "evals") => {
  await write(`${dir}/support/harbor.yaml`, "datasets:\n  - path: tasks\n");
  await write(
    `${dir}/support/tasks/dataset.toml`,
    `[dataset]\nname = "${DS}"\n`,
  );
  await write(`${dir}/support/tasks/refund/task.toml`, taskToml("acme/refund"));
  await write(
    `${dir}/support/tasks/complaint/task.toml`,
    taskToml("acme/complaint"),
  );
  await write(`${dir}/support/tasks/complaint/environment/data.txt`, "v1");
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

    const pins = await pinsOf("evals/support");
    expect(Object.keys(pins!)).toEqual(["acme/complaint", "acme/refund"]);
    expect(pins!["acme/refund"]).toBe(
      await hashTaskDir(path.join(root, "evals/support/tasks/refund")),
    );
    expect(await read("evals/support/tasks/dataset.toml")).toContain(
      `[[tasks]]\nname = "acme/complaint"\ndigest = "sha256:`,
    );
    expect(await readDatasetState(path.join(root, "evals/support"))).toEqual(
      pins,
    );
    expect(await read("evals/.gitignore")).toContain(
      "*/tasks/*\n!*/tasks/dataset.toml\n",
    );
    expect(laminar.calls.filter((c) => c.startsWith("upload"))).toHaveLength(2);

    // Another checkout: harbor.yaml + tasks/dataset.toml, no task dirs.
    await write("clone/support/harbor.yaml", "datasets:\n  - path: tasks\n");
    await cp(
      path.join(root, "evals/support/tasks/dataset.toml"),
      path.join(root, "clone/support/tasks/dataset.toml"),
    );
    await handleDatasetPull([], opts("clone"));
    expect(
      await read("clone/support/tasks/complaint/environment/data.txt"),
    ).toBe("v1");
    expect(await readDatasetState(path.join(root, "clone/support"))).toEqual(
      pins,
    );

    // Nothing changed: a second push uploads and pushes nothing. The dataset
    // can be named by its folder or its name.
    laminar.calls.length = 0;
    await handleDatasetPush(["support"], opts("clone"));
    await handleDatasetPush([DS], opts("clone"));
    expect(laminar.calls).toEqual([`get ${DS}`, `get ${DS}`]);
  });

  void it("knows tasks by [task] name, not by dir", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const pins = await pinsOf("evals/support");

    // Renaming the dir changes nothing.
    await cp(
      path.join(root, "evals/support/tasks/refund"),
      path.join(root, "evals/support/tasks/refund-renamed"),
      { recursive: true },
    );
    await rm(path.join(root, "evals/support/tasks/refund"), {
      recursive: true,
    });
    laminar.calls.length = 0;
    await handleDatasetPush([], opts("evals"));
    expect(await pinsOf("evals/support")).toEqual(pins);
    expect(laminar.calls).toEqual([`get ${DS}`]);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(root, "evals/support/tasks/refund"))).toBe(
      false,
    );

    // Renaming the task is a new task; the old one loses its pin.
    await write(
      "evals/support/tasks/refund-renamed/task.toml",
      taskToml("acme/refund-v2"),
    );
    await handleDatasetPush([], opts("evals"));
    expect(Object.keys((await pinsOf("evals/support"))!)).toEqual([
      "acme/complaint",
      "acme/refund-v2",
    ]);

    // --task matches the name, with or without the org.
    await write("evals/support/tasks/complaint/environment/data.txt", "v2");
    laminar.calls.length = 0;
    await handleDatasetPush([], opts("evals", { task: ["refund*"] }));
    expect(laminar.calls).toEqual([`get ${DS}`]);
    await handleDatasetPush([], opts("evals", { task: ["acme/compl*"] }));
    expect(laminar.calls).toContain(`push ${DS} acme/complaint`);
  });

  void it("refuses tasks without their own [task] name", async () => {
    await writeDataset();
    await write("evals/support/tasks/unnamed/task.toml", "[task]\n");
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        "support/tasks/unnamed: task.toml has no [task] name",
      ),
    });
    await rm(path.join(root, "evals/support/tasks/unnamed"), {
      recursive: true,
    });
    // A copied task that kept its name.
    await cp(
      path.join(root, "evals/support/tasks/refund"),
      path.join(root, "evals/support/tasks/refund-copy"),
      { recursive: true },
    );
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        'support/tasks/refund, support/tasks/refund-copy all have [task] name = "acme/refund"',
      ),
    });
    expect(laminar.calls).toEqual([]);
  });

  void it("refuses to push env files", async () => {
    await writeDataset();
    await write("evals/support/tasks/refund/environment/.env", "KEY=secret");
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining("support/tasks/refund/environment/.env"),
    });
    expect(laminar.calls.some((c) => c.startsWith("upload"))).toBe(false);
    // Left out by the task's .gitignore, it's fine (and not hashed).
    await write("evals/support/tasks/refund/.gitignore", ".env\n");
    await handleDatasetPush([], opts("evals"));
    expect(Object.keys((await pinsOf("evals/support"))!)).toHaveLength(2);
  });

  void it("pulls a new task into the dir named after it, if that is free", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write("other/support/tasks/x/task.toml", taskToml("acme/new-case"));
    await handleDatasetPush([], opts("other"));

    await write("evals/support/tasks/new-case/notes.md", "mine");
    await expect(
      handleDatasetPull([], opts("evals", { latest: true })),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        "Can't pull acme/new-case into support/tasks/new-case",
      ),
    });
    await rm(path.join(root, "evals/support/tasks/new-case"), {
      recursive: true,
    });
    await handleDatasetPull([], opts("evals", { latest: true }));
    expect(await read("evals/support/tasks/new-case/task.toml")).toBe(
      taskToml("acme/new-case"),
    );
  });

  void it("never pulls a task onto a file, such as dataset.toml", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write(
      "other/support/tasks/x/task.toml",
      taskToml("acme/dataset.toml"),
    );
    await handleDatasetPush([], opts("other"));

    const manifest = await read("evals/support/tasks/dataset.toml");
    await expect(
      handleDatasetPull([], opts("evals", { latest: true })),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        "Can't pull acme/dataset.toml into support/tasks/dataset.toml",
      ),
    });
    expect(await read("evals/support/tasks/dataset.toml")).toBe(manifest);
  });

  void it("leaves symlinked task dirs alone", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");
    const pins = await pinsOf("evals/support");

    // complaint now links to a folder outside the dataset.
    await cp(
      path.join(ds, "tasks/complaint"),
      path.join(root, "shared/complaint"),
      { recursive: true },
    );
    await write("shared/complaint/environment/data.txt", "linked");
    await rm(path.join(ds, "tasks/complaint"), { recursive: true });
    await symlink(
      path.join(root, "shared/complaint"),
      path.join(ds, "tasks/complaint"),
    );

    // Push keeps its pin; pull and the run's pre-pull keep the link.
    await handleDatasetPush([], opts("evals"));
    expect(await pinsOf("evals/support")).toEqual(pins);
    await handleDatasetPull([], opts("evals"));
    await pullRunTasks(path.join(root, "evals"), ["support"], undefined, {});
    expect(
      (await lstat(path.join(ds, "tasks/complaint"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("linked");
  });

  void it("refuses to overwrite local edits without --force (exit 22)", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const pinned = (await pinsOf("evals/support"))!["acme/complaint"];

    // A teammate pushes v2 of complaint; here, it is edited locally.
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write("other/support/tasks/complaint/environment/data.txt", "v2");
    await handleDatasetPush([], opts("other"));
    await write("evals/support/tasks/complaint/environment/data.txt", "mine");

    await expect(
      handleDatasetPull(["support"], opts("evals", { latest: true })),
    ).rejects.toMatchObject({
      code: "local_edits",
      exitCode: 22,
      message: expect.stringContaining(
        "acme/complaint (support/tasks/complaint)",
      ),
    });
    await expect(
      handleDatasetPull(
        ["support"],
        opts("evals", { latest: true, dryRun: true }),
      ),
    ).rejects.toMatchObject({ exitCode: 22 });
    // Nothing was written.
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("mine");
    expect((await pinsOf("evals/support"))!["acme/complaint"]).toBe(pinned);

    await handleDatasetPull(
      ["support"],
      opts("evals", { latest: true, force: true }),
    );
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("v2");
    expect((await pinsOf("evals/support"))!["acme/complaint"]).not.toBe(pinned);
  });

  void it("refuses a push whose pin moved in Laminar (exit 23) until pulled", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write(
      "other/support/tasks/refund/task.toml",
      taskToml("acme/refund", "v = 2\n"),
    );
    await handleDatasetPush([], opts("other"));

    // Unedited here, but Laminar moved: refused, dry run too.
    await write("evals/support/tasks/complaint/environment/data.txt", "v3");
    for (const dryRun of [true, false]) {
      await expect(
        handleDatasetPush([], opts("evals", { dryRun })),
      ).rejects.toMatchObject({
        code: "pin_moved",
        exitCode: 23,
        message: expect.stringContaining(
          "eval dataset pull support --dir " +
            `${path.join(root, "evals")} --latest --task acme/refund`,
        ),
      });
    }
    expect(laminar.calls.filter((c) => c.startsWith("push"))).toEqual([
      `push ${DS} acme/complaint,acme/refund`,
      `push ${DS} acme/refund`,
    ]);

    await handleDatasetPull(
      ["support"],
      opts("evals", { latest: true, task: ["acme/refund"] }),
    );
    await handleDatasetPush([], opts("evals"));
    expect((await pinsOf("evals/support"))!["acme/complaint"]).toBe(
      await hashTaskDir(path.join(root, "evals/support/tasks/complaint")),
    );
  });

  void it("turns the server's 409 moved into exit 23", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await write(
      "evals/support/tasks/refund/task.toml",
      taskToml("acme/refund", "v = 3\n"),
    );
    const push = vi
      .spyOn(
        (laminar.client as unknown as { evalDatasets: { push: () => unknown } })
          .evalDatasets,
        "push",
      )
      .mockResolvedValue({
        status: "moved",
        moved: [{ task: "acme/refund", latest: "f".repeat(64) }],
      });
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "pin_moved",
      message: expect.stringMatching(/acme\/refund: Laminar's latest/),
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
    expect(Object.keys((await pinsOf("evals/support"))!)).toEqual([
      "acme/complaint",
    ]);

    // A pin removed from dataset.toml (e.g. by git) removes the dir on pull.
    await setPins("evals/support", {});
    await handleDatasetPull([], opts("evals", { dryRun: true, json: true }));
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(true);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(false);
    expect(await readDatasetState(ds)).toEqual({});
    // An empty pin list stays one: it doesn't mean "pull the latest".
    expect(await pinsOf("evals/support")).toEqual({});
  });

  void it("pulls the latest when dataset.toml pins nothing yet", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await write("fresh/support/harbor.yaml", "");
    await write(
      "fresh/support/tasks/dataset.toml",
      `[dataset]\nname = "${DS}"\n`,
    );
    await handleDatasetPull([DS], opts("fresh"));
    expect(
      await read("fresh/support/tasks/complaint/environment/data.txt"),
    ).toBe("v1");
    expect(await pinsOf("fresh/support")).toEqual(
      await pinsOf("evals/support"),
    );
    expect(await read("fresh/.gitignore")).toContain("*/tasks/*");
  });

  void it("needs a dataset.toml naming each dataset", async () => {
    await write("evals/local-only/harbor.yaml", "");
    await write("evals/local-only/tasks/a/task.toml", taskToml("acme/a"));
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining("No eval datasets"),
    });
    await expect(
      handleDatasetPush(["local-only"], opts("evals")),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining('name = "<org>/local-only"'),
    });
    await expect(
      handleDatasetPull(["nope"], opts("evals")),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
    expect(laminar.calls).toEqual([]);
  });

  void it("skips datasets Laminar doesn't have when nothing is pinned", async () => {
    await write("evals/new/harbor.yaml", "");
    await write(
      "evals/new/tasks/dataset.toml",
      '[dataset]\nname = "acme/new"\n',
    );
    await handleDatasetPull([], opts("evals"));
    expect(laminar.calls).toEqual(["get acme/new"]);
  });

  void it("fails clearly on a pinned version Laminar doesn't have", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await setPins("evals/support", { "acme/refund": "e".repeat(64) });
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
      code: "version_not_found",
      message: expect.stringContaining("acme/refund@eeeeeeeeeeee"),
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
    await write("evals/support/tasks/complaint/environment/data.txt", "mine");
    build.mockClear();
    await pullRunTasks(evalsDir, ["support"], undefined, {}, build);
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("mine");
    expect(build).not.toHaveBeenCalled();

    // Re-pinned (e.g. git pull) and unedited: pulled.
    await cp(evalsDir, path.join(root, "other"), { recursive: true });
    await write(
      "other/support/tasks/refund/task.toml",
      taskToml("acme/refund", "v = 2\n"),
    );
    await handleDatasetPush([], opts("other", { task: ["refund"] }));
    await cp(
      path.join(root, "other/support/tasks/dataset.toml"),
      path.join(ds, "tasks/dataset.toml"),
    );
    // Laminar unreachable, but the task is on disk: the run goes on.
    const down = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await pullRunTasks(evalsDir, ["support"], undefined, {}, down);
    expect(await read("evals/support/tasks/refund/task.toml")).toBe(
      taskToml("acme/refund"),
    );
    // eval run's --task is Harbor's: it matches task dirs.
    await pullRunTasks(evalsDir, ["support"], ["ref*"], {}, build);
    expect(await read("evals/support/tasks/refund/task.toml")).toBe(
      taskToml("acme/refund", "v = 2\n"),
    );

    // A missing task can't run without Laminar.
    await rm(path.join(ds, "tasks/refund"), { recursive: true });
    await expect(
      pullRunTasks(evalsDir, ["support"], undefined, {}, down),
    ).rejects.toThrow(/fetch failed/);
  });
});
