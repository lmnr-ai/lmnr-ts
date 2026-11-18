import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatStatus,
  parseVersion,
  prepareRunDatasets,
  pullDatasets,
  pushDatasets,
  statusDatasets,
} from "./dataset-sync";
import { type DatasetLock, readLock, readState, writeLock } from "./lockfile";
import { hashLocalTasks, listTasks } from "./tasks";

let root: string;
let evals: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(evals, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const apiError = (status: number, message: string, missing?: string[]) =>
  Object.assign(new Error(`${status} ${message}`), { status, missing });

/** An in-memory Laminar: content-addressed tasks and numbered versions. */
const fakeLaminar = () => {
  const blobs = new Map<string, Uint8Array>();
  const indexed = new Set<string>();
  const datasets = new Map<string, DatasetLock[]>();
  const evalDatasets = {
    missingTasks: vi.fn(async (hashes: string[]) =>
      hashes.filter((h) => !indexed.has(h)),
    ),
    uploadTask: vi.fn(async (hash: string, archive: Uint8Array) => {
      blobs.set(hash, archive);
    }),
    uploadTaskIndex: vi.fn(async (hash: string) => {
      if (!blobs.has(hash)) throw apiError(404, "Archive not uploaded");
      indexed.add(hash);
    }),
    downloadTask: vi.fn(async (hash: string) => {
      const blob = blobs.get(hash);
      if (!blob || !indexed.has(hash)) throw apiError(404, "Task not found");
      return new Blob([blob as Uint8Array<ArrayBuffer>]).stream();
    }),
    getVersion: vi.fn(async (name: string, version: number | "latest") => {
      const versions = datasets.get(name) ?? [];
      const found =
        version === "latest"
          ? versions[versions.length - 1]
          : versions.find((v) => v.version === version);
      if (!found) throw apiError(404, "Eval dataset version not found");
      return {
        datasetId: `id-${name}`,
        dataset: name,
        version: found.version,
        parentVersion: null,
        message: null,
        createdAt: "2026-11-18T00:00:00Z",
        tasks: found.tasks,
      };
    }),
    createVersion: vi.fn(
      async (
        name: string,
        body: { parentVersion?: number | null; tasks: Record<string, string> },
      ) => {
        const missing = Object.values(body.tasks).filter(
          (h) => !indexed.has(h),
        );
        if (missing.length > 0) {
          throw apiError(409, "Tasks not uploaded", missing);
        }
        const versions = datasets.get(name) ?? [];
        const previousLatest = versions.length || null;
        const version = versions.length + 1;
        versions.push({ dataset: name, version, tasks: { ...body.tasks } });
        datasets.set(name, versions);
        return {
          datasetId: `id-${name}`,
          dataset: name,
          version,
          previousLatest,
        };
      },
    ),
  };
  const client = { evalDatasets } as unknown as LaminarClient;
  const getClient = vi.fn(async () => client);
  return { evalDatasets, getClient, indexed, blobs };
};

const localHashes = async (folder: string) =>
  hashLocalTasks(await listTasks(path.join(evals, folder)));

/** `support` with two tasks. */
const writeSupport = async () => {
  await write("support/harbor.yaml", "agents: []\n");
  await write("support/tasks/refund/task.toml", "[task]\nname = 'refund'\n");
  await write("support/tasks/refund/instruction.md", "Refund it.");
  await write("support/tasks/greet/task.toml", "[task]\nname = 'greet'\n");
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

void describe("eval push", () => {
  void it("creates v1, then only uploads what changed, then is up to date", async () => {
    await writeSupport();
    const server = fakeLaminar();

    const [first] = await pushDatasets(
      evals,
      ["support"],
      { message: "first" },
      server.getClient,
    );
    expect(first).toMatchObject({
      dataset: "support",
      version: 1,
      parentVersion: null,
      previousLatest: null,
      upToDate: false,
      uploaded: 2,
      tasks: 2,
      added: ["greet", "refund"],
    });
    expect(server.evalDatasets.createVersion).toHaveBeenCalledWith("support", {
      parentVersion: null,
      message: "first",
      tasks: await localHashes("support"),
    });
    const lock = await readLock(path.join(evals, "support"));
    expect(lock).toEqual({
      dataset: "support",
      version: 1,
      tasks: await localHashes("support"),
    });
    expect(await readState(path.join(evals, "support"))).toEqual(lock);
    expect(await readFile(path.join(evals, "support/.gitignore"), "utf8")).toBe(
      "/tasks/\n",
    );

    // Unchanged: no request at all.
    server.getClient.mockClear();
    const [same] = await pushDatasets(evals, ["support"], {}, server.getClient);
    expect(same).toMatchObject({ upToDate: true, version: 1, uploaded: 0 });
    expect(server.getClient).not.toHaveBeenCalled();

    await write("support/tasks/refund/instruction.md", "Refund it twice.");
    await write("support/tasks/new/task.toml", "[task]\nname = 'greet'\n");
    const [second] = await pushDatasets(
      evals,
      ["support"],
      {},
      server.getClient,
    );
    // `new` has the same content as `greet`: nothing to upload for it.
    expect(second).toMatchObject({
      version: 2,
      parentVersion: 1,
      uploaded: 1,
      added: ["new"],
      modified: ["refund"],
      removed: [],
    });
    expect(server.evalDatasets.createVersion).toHaveBeenLastCalledWith(
      "support",
      expect.objectContaining({ parentVersion: 1 }),
    );
    expect((await readLock(path.join(evals, "support")))?.version).toBe(2);
  });

  void it("warns when it doesn't build on the latest version", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, ["support"], {}, server.getClient);
    // Someone else pushes v2 from v1 on another branch.
    await server.evalDatasets.createVersion("support", {
      parentVersion: 1,
      tasks: {},
    });
    await write("support/tasks/greet/extra.txt", "y");

    const [result] = await pushDatasets(
      evals,
      ["support"],
      {},
      server.getClient,
    );
    expect(result).toMatchObject({
      version: 3,
      parentVersion: 1,
      previousLatest: 2,
    });
  });

  void it("uploads what the server still misses, once", async () => {
    await writeSupport();
    const server = fakeLaminar();
    // The missing check says nothing is missing, but a task isn't uploaded.
    server.evalDatasets.missingTasks.mockResolvedValueOnce([]);

    const [result] = await pushDatasets(
      evals,
      ["support"],
      {},
      server.getClient,
    );
    expect(result.version).toBe(1);
    expect(server.evalDatasets.createVersion).toHaveBeenCalledTimes(2);
    expect(server.indexed.size).toBe(2);
  });

  void it("refuses to push a tasks/ older than the lockfile pins", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, ["support"], {}, server.getClient);
    await write("support/tasks/greet/extra.txt", "y");
    await pushDatasets(evals, ["support"], {}, server.getClient);
    // Back at v1 (synced), while lmnr.lock (from git) pins v2.
    await pullDatasets(evals, ["support"], { version: 1 }, server.getClient);
    const v2 = await server.evalDatasets.getVersion("support", 2);
    await writeLock(path.join(evals, "support"), {
      dataset: "support",
      version: 2,
      tasks: v2.tasks,
    });
    await write("support/tasks/refund/instruction.md", "edit on v1");

    await expect(
      pushDatasets(evals, ["support"], {}, server.getClient),
    ).rejects.toMatchObject({
      code: "tasks_behind_lock",
      exitCode: 23,
      message: expect.stringMatching(/synced to v1, lmnr.lock pins v2/),
    });
    const [forced] = await pushDatasets(
      evals,
      ["support"],
      { force: true },
      server.getClient,
    );
    expect(forced).toMatchObject({ version: 3, parentVersion: 2 });
  });

  void it("rejects bad task names and a missing tasks/ before uploading", async () => {
    await writeSupport();
    await write("support/tasks/bad name/task.toml");
    await write("empty/harbor.yaml");
    const server = fakeLaminar();

    await expect(
      pushDatasets(evals, ["support"], {}, server.getClient),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/invalid task folder name\(s\): bad name/),
    });
    await expect(
      pushDatasets(evals, ["empty"], {}, server.getClient),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/nothing to push/),
    });
    expect(server.getClient).not.toHaveBeenCalled();
  });
});

void describe("eval pull", () => {
  void it("restores tasks/ from the lockfile and any version, from the cache", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, ["support"], {}, server.getClient);
    const v1 = await localHashes("support");
    await write("support/tasks/refund/instruction.md", "v2");
    await rm(path.join(evals, "support/tasks/greet"), { recursive: true });
    await pushDatasets(evals, ["support"], {}, server.getClient);
    const v2 = await localHashes("support");

    await rm(path.join(evals, "support/tasks"), { recursive: true });
    const [restored] = await pullDatasets(
      evals,
      ["support"],
      {},
      server.getClient,
    );
    expect(restored).toMatchObject({
      version: 2,
      updated: ["refund"],
      removed: [],
      lockUpdated: false,
    });
    expect(await localHashes("support")).toEqual(v2);
    // The lockfile's own version needs no lookup.
    expect(server.evalDatasets.getVersion).not.toHaveBeenCalled();

    const [old] = await pullDatasets(
      evals,
      ["support"],
      { version: 1 },
      server.getClient,
    );
    expect(old).toMatchObject({
      version: 1,
      previousVersion: 2,
      updated: ["greet", "refund"],
      lockUpdated: true,
    });
    expect(await localHashes("support")).toEqual(v1);
    expect((await readLock(path.join(evals, "support")))?.version).toBe(1);
    expect((await readState(path.join(evals, "support")))?.version).toBe(1);

    const downloads = server.evalDatasets.downloadTask.mock.calls.length;
    const [latest] = await pullDatasets(
      evals,
      ["support"],
      { version: "latest" },
      server.getClient,
    );
    expect(latest).toMatchObject({ version: 2, removed: ["greet"] });
    expect(server.evalDatasets.downloadTask.mock.calls.length).toBe(downloads);
    expect(await localHashes("support")).toEqual(v2);
  });

  void it("pulls a dataset with no lockfile by its folder name", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await pushDatasets(evals, ["support"], {}, server.getClient);
    await rm(path.join(evals, "support/lmnr.lock"));
    await rm(path.join(evals, "support/tasks"), { recursive: true });
    await rm(path.join(evals, "support/.gitignore"));

    const [result] = await pullDatasets(
      evals,
      ["support"],
      {},
      server.getClient,
    );
    expect(result).toMatchObject({ version: 1, lockUpdated: true });
    expect(server.evalDatasets.getVersion).toHaveBeenCalledWith(
      "support",
      "latest",
    );
    expect(existsSync(path.join(evals, "support/.gitignore"))).toBe(true);
  });

  void it("refuses to overwrite local changes, in any dataset, unless forced", async () => {
    await writeSupport();
    await write("other/harbor.yaml");
    await write("other/tasks/o/task.toml");
    const server = fakeLaminar();
    await pushDatasets(evals, ["support", "other"], {}, server.getClient);
    await rm(path.join(evals, "other/tasks"), { recursive: true });
    await write("support/tasks/refund/instruction.md", "local edit");

    await expect(
      pullDatasets(
        evals,
        ["other", "support"],
        { version: 1 },
        server.getClient,
      ),
    ).rejects.toMatchObject({
      code: "local_changes",
      exitCode: 22,
      message: expect.stringMatching(/support: modified refund since v1/),
    });
    // Nothing was touched, not even the dataset without changes.
    expect(existsSync(path.join(evals, "other/tasks"))).toBe(false);
    expect(
      await readFile(
        path.join(evals, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("local edit");

    await pullDatasets(evals, ["support"], { force: true }, server.getClient);
    expect(
      await readFile(
        path.join(evals, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("Refund it.");
  });

  void it("fails clearly for a dataset or version Laminar doesn't have", async () => {
    await writeSupport();
    const server = fakeLaminar();
    await expect(
      pullDatasets(evals, ["support"], {}, server.getClient),
    ).rejects.toMatchObject({
      code: "dataset_not_found",
      exitCode: 24,
      message: expect.stringMatching(/^Dataset support is not in Laminar/),
    });
    server.evalDatasets.getVersion.mockRejectedValueOnce(
      apiError(404, "Eval datasets need S3 storage on this deployment"),
    );
    await expect(
      pullDatasets(evals, ["support"], {}, server.getClient),
    ).rejects.toThrow(/^404 Eval datasets need S3 storage/);
  });

  void it("parses --version", () => {
    expect(parseVersion("3")).toBe(3);
    expect(parseVersion("latest")).toBe("latest");
    for (const bad of ["0", "-1", "1.5", "v3", ""]) {
      expect(() => parseVersion(bad)).toThrow(/version number or `latest`/);
    }
  });
});

void describe("eval status", () => {
  void it("reports each dataset against its lockfile", async () => {
    await writeSupport();
    await write("draft/harbor.yaml");
    await write("draft/tasks/d/task.toml");
    const server = fakeLaminar();
    await pushDatasets(evals, ["support"], {}, server.getClient);
    await write("support/tasks/refund/instruction.md", "edit");
    await write("support/tasks/added/task.toml", "new");

    const statuses = await statusDatasets(evals, ["draft", "support"]);
    expect(statuses).toEqual([
      expect.objectContaining({ path: "draft", state: "not_pushed", tasks: 1 }),
      expect.objectContaining({
        path: "support",
        version: 1,
        syncedVersion: 1,
        state: "modified",
        added: ["added"],
        modified: ["refund"],
        removed: [],
      }),
    ]);
    const text = formatStatus(statuses);
    expect(text).toMatch(/draft {4}- {2}.*not pushed/);
    expect(text).toMatch(
      /support {2}v1 {2}.*modified.*1 added, 1 modified, 0 removed/,
    );
    expect(text).toMatch(/ {4}\+ added\n {4}~ refund\n$/);
  });
});

void describe("eval run: syncing and group names", () => {
  void it("names groups by version and pulls only when nothing is lost", async () => {
    await writeSupport();
    await write("draft/harbor.yaml");
    await write("draft/tasks/d/task.toml");
    const server = fakeLaminar();
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Never pushed: unversioned, no login needed.
    expect(
      await prepareRunDatasets(evals, ["draft", "support"], server.getClient),
    ).toEqual([
      { path: "draft", group: "draft unversioned" },
      { path: "support", group: "support unversioned" },
    ]);
    expect(server.getClient).not.toHaveBeenCalled();

    await pushDatasets(evals, ["support"], {}, server.getClient);
    expect(
      await prepareRunDatasets(evals, ["support"], server.getClient),
    ).toEqual([{ path: "support", group: "support v1" }]);

    // Local edits: unversioned, tasks/ left alone.
    await write("support/tasks/refund/instruction.md", "edited");
    expect(
      await prepareRunDatasets(evals, ["support"], server.getClient),
    ).toEqual([{ path: "support", group: "support unversioned" }]);
    expect(
      await readFile(
        path.join(evals, "support/tasks/refund/instruction.md"),
        "utf8",
      ),
    ).toBe("edited");

    // Pushed as v2 elsewhere; here tasks/ is still v1 → pulled, then run.
    await pushDatasets(evals, ["support"], {}, server.getClient);
    const v2 = await localHashes("support");
    await pullDatasets(evals, ["support"], { version: 1 }, server.getClient);
    await writeLock(path.join(evals, "support"), {
      dataset: "support",
      version: 2,
      tasks: v2,
    });
    expect(
      await prepareRunDatasets(evals, ["support"], server.getClient),
    ).toEqual([{ path: "support", group: "support v2" }]);
    expect(await localHashes("support")).toEqual(v2);

    // A fresh clone: lmnr.lock without tasks/.
    await rm(path.join(evals, "support/tasks"), { recursive: true });
    expect(
      await prepareRunDatasets(evals, ["support"], server.getClient),
    ).toEqual([{ path: "support", group: "support v2" }]);
    expect(await localHashes("support")).toEqual(v2);
    warn.mockRestore();
  });

  void it("fails for a dataset with neither tasks/ nor a lockfile", async () => {
    await write("empty/harbor.yaml");
    await expect(
      prepareRunDatasets(evals, ["empty"], fakeLaminar().getClient),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/doesn't exist and there's no lmnr.lock/),
    });
  });
});
