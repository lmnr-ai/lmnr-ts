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
  checkRunTasks,
  handleDatasetPull,
  handleDatasetPush,
} from "./dataset-command";
import { readDatasetToml, writeDatasetToml } from "./dataset-toml";
import { hashTaskDir } from "./task-hash";

vi.mock("./client", () => ({ buildEvalClient: vi.fn() }));
// Tests run with LMNR_LOG_LEVEL=silent; checkRunTasks's warnings are asserted here.
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ initializeLogger: () => logger }));

const apiError = (status: number, code: string) =>
  Object.assign(new Error(`${status} ${code}`), {
    name: "LaminarApiError",
    status,
    code,
  });

/**
 * An in-memory Laminar following the eval datasets contract: versions are
 * independent, and one counts once its index is uploaded.
 */
const fakeLaminar = () => {
  type Version = { archive: Uint8Array; indexed: boolean };
  const store = new Map<string, Version>();
  const key = (dataset: string, task: string, hash: string) =>
    `${dataset} ${task} ${hash}`;
  const has = (dataset: string, task: string, hash: string) =>
    store.get(key(dataset, task, hash))?.indexed === true;
  const calls: string[] = [];

  const evalDatasets = {
    missingVersions: async (
      dataset: string,
      versions: { task: string; hash: string }[],
    ) => {
      calls.push(`missing ${dataset}`);
      return versions.filter((v) => !has(dataset, v.task, v.hash));
    },
    uploadVersion: async (
      dataset: string,
      task: string,
      hash: string,
      archive: Uint8Array,
    ) => {
      calls.push(`upload ${dataset}/${task}`);
      store.set(key(dataset, task, hash), { archive, indexed: false });
    },
    uploadVersionIndex: async (dataset: string, task: string, hash: string) => {
      const v = store.get(key(dataset, task, hash));
      if (!v) throw apiError(404, "archive_not_found");
      v.indexed = true;
    },
    downloadVersion: async (dataset: string, task: string, hash: string) => {
      calls.push(`download ${dataset}/${task}`);
      const v = store.get(key(dataset, task, hash));
      if (!v?.indexed) throw apiError(404, "version_not_found");
      return new Blob([v.archive as Uint8Array<ArrayBuffer>]).stream();
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

/** `git pull` of another checkout's dataset.toml. */
const takeManifest = (from: string, to: string) =>
  cp(
    path.join(root, from, "support/tasks/dataset.toml"),
    path.join(root, to, "support/tasks/dataset.toml"),
  );
const uploads = () => laminar.calls.filter((c) => c.startsWith("upload"));

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
    expect(await read("evals/.gitignore")).toContain(
      "*/tasks/*\n!*/tasks/dataset.toml\n",
    );
    expect(uploads()).toHaveLength(2);

    // Another checkout: harbor.yaml + tasks/dataset.toml, no task dirs.
    await write("clone/support/harbor.yaml", "datasets:\n  - path: tasks\n");
    await mkdir(path.join(root, "clone/support/tasks"));
    await takeManifest("evals", "clone");
    await handleDatasetPull([], opts("clone"));
    expect(
      await read("clone/support/tasks/complaint/environment/data.txt"),
    ).toBe("v1");
    expect(
      existsSync(path.join(root, "clone/support/tasks/.lmnr-state.json")),
    ).toBe(false);

    // Nothing changed: a second push uploads nothing. The dataset can be
    // named by its folder or its name.
    laminar.calls.length = 0;
    await handleDatasetPush(["support"], opts("clone"));
    await handleDatasetPush([DS], opts("clone"));
    expect(laminar.calls).toEqual([`missing ${DS}`, `missing ${DS}`]);
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
    expect(laminar.calls).toEqual([`missing ${DS}`]);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(root, "evals/support/tasks/refund"))).toBe(
      false,
    );

    // Renaming the task is a new task; the old one keeps its pin until it is
    // taken out of dataset.toml.
    await write(
      "evals/support/tasks/refund-renamed/task.toml",
      taskToml("acme/refund-v2"),
    );
    await handleDatasetPush([], opts("evals"));
    expect(Object.keys((await pinsOf("evals/support"))!)).toEqual([
      "acme/complaint",
      "acme/refund",
      "acme/refund-v2",
    ]);

    // --task matches the name, with or without the org.
    await write("evals/support/tasks/complaint/environment/data.txt", "v2");
    laminar.calls.length = 0;
    await handleDatasetPush([], opts("evals", { task: ["refund*"] }));
    expect(laminar.calls).toEqual([`missing ${DS}`]);
    await handleDatasetPush([], opts("evals", { task: ["acme/compl*"] }));
    expect(uploads()).toEqual([`upload ${DS}/acme/complaint`]);
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
    expect(uploads()).toEqual([]);
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
    await takeManifest("other", "evals");

    await write("evals/support/tasks/new-case/notes.md", "mine");
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        "Can't pull acme/new-case into support/tasks/new-case",
      ),
    });
    await rm(path.join(root, "evals/support/tasks/new-case"), {
      recursive: true,
    });
    await handleDatasetPull([], opts("evals"));
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
    await takeManifest("other", "evals");

    const manifest = await read("evals/support/tasks/dataset.toml");
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
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

    // Push keeps its pin; pull and the run's check keep the link.
    await handleDatasetPush([], opts("evals"));
    expect(await pinsOf("evals/support")).toEqual(pins);
    await handleDatasetPull([], opts("evals"));
    await checkRunTasks(path.join(root, "evals"), ["support"], undefined);
    expect(
      (await lstat(path.join(ds, "tasks/complaint"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("linked");
  });

  void it("updates tasks to their pins after a git pull, skipping them on push", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write("other/support/tasks/complaint/environment/data.txt", "v2");
    await handleDatasetPush([], opts("other"));
    await takeManifest("other", "evals");

    // complaint here is at the old version, which Laminar has: push skips it.
    laminar.calls.length = 0;
    await handleDatasetPush([], opts("evals"));
    expect(uploads()).toEqual([]);
    expect(await pinsOf("evals/support")).toEqual(
      await pinsOf("other/support"),
    );

    // Pull replaces it without --force: nothing local is lost.
    await handleDatasetPull([], opts("evals"));
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("v2");
  });

  void it("refuses to overwrite versions Laminar doesn't have without --force (exit 22)", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));

    // A teammate pushes v2 of complaint; here, it is edited, and dataset.toml
    // arrives with a git pull.
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });
    await write("other/support/tasks/complaint/environment/data.txt", "v2");
    await handleDatasetPush([], opts("other"));
    await write("evals/support/tasks/complaint/environment/data.txt", "mine");
    await takeManifest("other", "evals");

    for (const dryRun of [false, true]) {
      await expect(
        handleDatasetPull(["support"], opts("evals", { dryRun })),
      ).rejects.toMatchObject({
        code: "local_edits",
        exitCode: 22,
        message: expect.stringContaining(
          "acme/complaint (support/tasks/complaint)",
        ),
      });
    }
    // Nothing was written.
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("mine");

    await handleDatasetPull(["support"], opts("evals", { force: true }));
    expect(
      await read("evals/support/tasks/complaint/environment/data.txt"),
    ).toBe("v2");
  });

  void it("stores concurrent edits as separate versions; dataset.toml picks one", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await cp(path.join(root, "evals"), path.join(root, "other"), {
      recursive: true,
    });

    // Both edit refund and push: both versions are stored and pinned locally.
    await write(
      "evals/support/tasks/refund/task.toml",
      taskToml("acme/refund", "v = 2\n"),
    );
    await write(
      "other/support/tasks/refund/task.toml",
      taskToml("acme/refund", "v = 3\n"),
    );
    await handleDatasetPush([], opts("evals"));
    await handleDatasetPush([], opts("other"));
    expect(uploads().slice(2)).toEqual([
      `upload ${DS}/acme/refund`,
      `upload ${DS}/acme/refund`,
    ]);
    const mine = (await pinsOf("evals/support"))!["acme/refund"];
    const theirs = (await pinsOf("other/support"))!["acme/refund"];
    expect(mine).not.toBe(theirs);

    // The git merge takes theirs: pull switches without --force, since
    // Laminar has this checkout's version too.
    await takeManifest("other", "evals");
    await handleDatasetPull([], opts("evals"));
    expect(await read("evals/support/tasks/refund/task.toml")).toBe(
      taskToml("acme/refund", "v = 3\n"),
    );
  });

  void it("removes tasks dropped from dataset.toml, never unpins on push", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");
    const pins = await pinsOf("evals/support");

    // Deleting a task's dir keeps its pin, and pull brings it back.
    await rm(path.join(ds, "tasks/refund"), { recursive: true });
    await handleDatasetPush([], opts("evals"));
    expect(await pinsOf("evals/support")).toEqual(pins);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(ds, "tasks/refund"))).toBe(true);

    // Taking it out of dataset.toml: push skips it, pull removes the dir.
    await setPins("evals/support", {
      "acme/complaint": pins!["acme/complaint"],
    });
    await handleDatasetPush([], opts("evals"));
    expect(Object.keys((await pinsOf("evals/support"))!)).toEqual([
      "acme/complaint",
    ]);
    await handleDatasetPull([], opts("evals", { dryRun: true, json: true }));
    expect(existsSync(path.join(ds, "tasks/refund"))).toBe(true);
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(ds, "tasks/refund"))).toBe(false);
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(true);
  });

  void it("leaves new tasks for push", async () => {
    await writeDataset();
    await handleDatasetPull([], opts("evals"));
    expect(existsSync(path.join(root, "evals/support/tasks/refund"))).toBe(
      true,
    );
    expect(laminar.calls).toEqual([`missing ${DS}`]);
    expect(await pinsOf("evals/support")).toBeNull();
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

  void it("fails clearly on a pinned version Laminar doesn't have", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    await setPins("evals/support", { "acme/refund": "e".repeat(64) });
    await expect(handleDatasetPull([], opts("evals"))).rejects.toMatchObject({
      code: "version_not_found",
      message: expect.stringContaining("acme/refund@eeeeeeeeeeee"),
    });
    expect(existsSync(path.join(root, "evals/support/tasks/complaint"))).toBe(
      true,
    );
  });

  void it("explains a deployment without storage", async () => {
    await writeDataset();
    vi.spyOn(
      (
        laminar.client as unknown as {
          evalDatasets: { missingVersions: () => unknown };
        }
      ).evalDatasets,
      "missingVersions",
    ).mockRejectedValue(apiError(501, "storage_not_configured"));
    await expect(handleDatasetPush([], opts("evals"))).rejects.toMatchObject({
      code: "storage_not_configured",
      message: expect.stringMatching(/no storage for eval datasets/),
    });
  });
});

void describe("checkRunTasks", () => {
  const warned = () =>
    logger.warn.mock.calls.map((c) => String(c[0])).join("\n");

  void it("runs the tasks on disk without pulling, and hashes them once", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const ds = path.join(root, "evals/support");
    const evalsDir = path.join(root, "evals");
    laminar.calls.length = 0;
    vi.mocked(buildEvalClient).mockClear();
    logger.warn.mockClear();

    // Edited and unpinned tasks run as they are; edits get a warning.
    await write("evals/support/tasks/complaint/environment/data.txt", "mine");
    await write("evals/support/tasks/new/task.toml", taskToml("acme/new"));
    const hashes = await checkRunTasks(evalsDir, ["support"], undefined);
    expect(warned()).toContain(
      "1 task(s) differ from their pin (acme/complaint)",
    );
    expect(hashes.support).toEqual({
      complaint: {
        name: "acme/complaint",
        hash: await hashTaskDir(path.join(ds, "tasks/complaint")),
      },
      new: {
        name: "acme/new",
        hash: await hashTaskDir(path.join(ds, "tasks/new")),
      },
      refund: {
        name: "acme/refund",
        hash: await hashTaskDir(path.join(ds, "tasks/refund")),
      },
    });
    // --task is Harbor's: it matches task dirs.
    expect(
      Object.keys(
        (await checkRunTasks(evalsDir, ["support"], ["ref*"])).support,
      ),
    ).toEqual(["refund"]);
    expect(laminar.calls).toEqual([]);
    expect(buildEvalClient).not.toHaveBeenCalled();
  });

  void it("warns about missing and differing pinned tasks, and doesn't fix them", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const evalsDir = path.join(root, "evals");
    const ds = path.join(evalsDir, "support");
    // A teammate pushes refund v2, and dataset.toml arrives with a git pull.
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
    await rm(path.join(ds, "tasks/complaint"), { recursive: true });

    logger.warn.mockClear();
    await checkRunTasks(evalsDir, ["support"], undefined, {
      dir: path.join(root, "evals"),
    });
    expect(warned()).toContain(
      "1 pinned task(s) are not in tasks/ and won't run (acme/complaint)",
    );
    expect(warned()).toContain("1 task(s) differ from their pin (acme/refund)");
    expect(warned()).toContain("`lmnr-cli eval dataset pull support --dir");
    expect(warned()).toContain("`lmnr-cli eval dataset push support --dir");
    expect(await read("evals/support/tasks/refund/task.toml")).toBe(
      taskToml("acme/refund"),
    );
    expect(existsSync(path.join(ds, "tasks/complaint"))).toBe(false);

    // Out of --task's selection: nothing to say.
    logger.warn.mockClear();
    await checkRunTasks(evalsDir, ["support"], ["nothing*"]);
    expect(warned()).toBe("");
  });

  void it("fails on a dataset that pins tasks but has none on disk", async () => {
    await writeDataset();
    await handleDatasetPush([], opts("evals"));
    const evalsDir = path.join(root, "evals");
    for (const dir of ["refund", "complaint"]) {
      await rm(path.join(evalsDir, "support/tasks", dir), { recursive: true });
    }
    await expect(
      checkRunTasks(evalsDir, ["support"], undefined),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringContaining(
        "pull them first: lmnr-cli eval dataset pull support",
      ),
    });
    // A dataset that pins nothing yet has nothing to pull.
    await writeFile(
      path.join(evalsDir, "support/tasks/dataset.toml"),
      `[dataset]\nname = "${DS}"\n`,
    );
    expect(await checkRunTasks(evalsDir, ["support"], undefined)).toEqual({
      support: {},
    });
  });
});
