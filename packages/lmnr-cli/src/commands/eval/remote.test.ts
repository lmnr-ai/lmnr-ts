import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imagePusher } from "./docker";
import { runDatasets } from "./harbor";
import type { ImageDef } from "./images";
import { packEvalsDir } from "./pack";
import {
  handleEvalOrchestrate,
  remoteExclude,
  remoteTaskVersions,
  startRemoteRun,
} from "./remote";
import { runCommand } from "./run-command";
import { hashTaskDir, packTaskDir } from "./task-hash";

vi.mock("./docker", () => ({ imagePusher: vi.fn() }));
vi.mock("./run-command", () => ({ runCommand: vi.fn() }));

const appended = vi.hoisted(() => [] as string[]);
/** Version archives the mocked client serves, by hash. */
const served = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@lmnr-ai/client", () => ({
  LaminarClient: class {
    evalDatasets = {
      downloadVersion: async (_d: string, _t: string, hash: string) =>
        new Blob([served.get(hash) as Uint8Array<ArrayBuffer>]).stream(),
    };
    hostedEvals = {
      appendRunLogs: async (_id: string, lines: { text: string }[]) => {
        appended.push(...lines.map((l) => l.text));
        return true;
      },
      uploadJob: async () => undefined,
      uploadJobIndex: async () => undefined,
    };
  },
}));

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** Two datasets using `app-evals`; dataset `a` also has its own Dockerfile. */
const writeEvals = async () => {
  for (const dataset of ["a", "b"]) {
    await write(
      `${dataset}/lmnr.yaml`,
      "images:\n  app-evals:\n    dockerfile: ../image/Dockerfile\n",
    );
    await write(
      `${dataset}/harbor.yaml`,
      "environment:\n  type: docker\ndatasets:\n  - path: tasks\n",
    );
    await write(
      `${dataset}/tasks/shared/task.toml`,
      '[environment]\ndocker_image = "app-evals"\n',
    );
  }
  await write("a/tasks/own/task.toml", "");
  await write("a/tasks/own/environment/Dockerfile", "FROM alpine");
};

const IMAGES = {
  images: {
    a: { "app-evals": "sha256:app-evals" },
    b: { "app-evals": "sha256:app-evals" },
  },
  dockerfiles: {
    a: { "tasks/own/environment": "sha256:a/tasks/own/environment" },
    b: {},
  },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-remote-"));
});

afterEach(async () => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(imagePusher).mockReset();
  appended.length = 0;
  served.clear();
  for (const key of [
    "LMNR_EVAL_RUN",
    "LMNR_EVAL_UPLOAD_ID",
    "LMNR_RUN_LOG_MARKER",
    "LMNR_PROJECT_API_KEY",
  ]) {
    delete process.env[key];
  }
  await rm(root, { recursive: true, force: true });
});

void describe("startRemoteRun", () => {
  void it("sends per-dataset image maps and Dockerfile digests", async () => {
    await writeEvals();
    vi.mocked(imagePusher).mockReturnValue({
      build: async (def: ImageDef) => `sha256:${def.name}`,
      pull: async (ref: string) => `sha256:${ref}`,
    });
    const startRun = vi.fn(async () => ({ sandboxId: "sb-1" }));
    const uploadIndex = vi.fn(async () => undefined);
    const client = {
      hostedEvals: {
        upload: async () => ({ uploadId: "up-1" }),
        uploadIndex,
        startRun,
      },
      evalDatasets: {
        // Laminar has none of the tasks: all are uploaded.
        missingVersions: async (_dataset: string, versions: unknown[]) =>
          versions,
      },
    } as unknown as LaminarClient;

    const started = await startRemoteRun(
      client,
      root,
      ["a", "b"],
      { nAttempts: 2 },
      { OPENAI_API_KEY: "sk", LMNR_PROJECT_API_KEY: "dropped" },
    );

    expect(started).toEqual({ uploadId: "up-1", sandboxId: "sb-1" });
    expect(uploadIndex).toHaveBeenCalledWith("up-1", {
      files: expect.arrayContaining([
        expect.objectContaining({ path: "a/tasks/own/task.toml" }),
      ]),
    });
    expect(startRun).toHaveBeenCalledWith({
      uploadId: "up-1",
      cliVersion: expect.any(String),
      spec: {
        datasets: ["a", "b"],
        overrides: { nAttempts: 2 },
        env: { OPENAI_API_KEY: "sk" },
        ...IMAGES,
        downloads: { a: {}, b: {} },
        taskHashes: {
          a: { own: expect.any(String), shared: expect.any(String) },
          b: { shared: expect.any(String) },
        },
      },
    });
  });
});

void describe("runDatasets", () => {
  void it("gives each remote dataset LMNR_EVAL_IMAGES with its own images", async () => {
    await writeEvals();
    const seen: { cwd?: string; images?: string }[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, _args, opts) => {
      seen.push({ cwd: opts?.cwd, images: opts?.env?.LMNR_EVAL_IMAGES });
      return 0;
    });

    expect(await runDatasets(root, ["a", "b"], {}, {}, IMAGES)).toEqual([]);
    expect(seen.map((s) => s.cwd)).toEqual([
      path.join(root, "a"),
      path.join(root, "b"),
    ]);
    expect(seen.map((s) => JSON.parse(s.images ?? "null"))).toEqual([
      { images: IMAGES.images.a, dockerfiles: IMAGES.dockerfiles.a },
      { images: IMAGES.images.b, dockerfiles: {} },
    ]);

    seen.length = 0;
    expect(await runDatasets(root, ["b"], {}, {})).toEqual([]);
    expect(seen).toEqual([{ cwd: path.join(root, "b"), images: undefined }]);
  });

  void it("writes each dataset's job where onDatasetEnd reads it, failed or not", async () => {
    await writeEvals();
    const configs: Record<string, unknown>[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const config = args[args.indexOf("-c") + 1];
      configs.push(JSON.parse(await readFile(config, "utf8")));
      return configs.length === 1 ? 1 : 0;
    });
    const ended: string[][] = [];
    const jobs = {
      dir: path.join(root, "jobs-out"),
      onDatasetEnd: async (dataset: string, jobDir: string) => {
        ended.push([dataset, jobDir]);
      },
    };

    expect(
      await runDatasets(root, ["a", "b"], {}, {}, IMAGES, { jobs }),
    ).toEqual(["a"]);
    // The job keeps Harbor's name: the plugin names the evaluation after it.
    expect(configs.map((c) => [c.jobs_dir, c.job_name])).toEqual([
      [path.join(jobs.dir, "a"), undefined],
      [path.join(jobs.dir, "b"), undefined],
    ]);
    expect(ended).toEqual([
      ["a", path.join(jobs.dir, "a")],
      ["b", path.join(jobs.dir, "b")],
    ]);
  });
});

void describe("remote tasks", () => {
  void it("uploads only the run's tasks Laminar doesn't have", async () => {
    await writeEvals();
    await write("a/tasks/.lmnr-state.json", "{}");
    await write("other/tasks.toml", "[tasks]\n");
    await write("other/tasks/x/task.toml", "");
    await write("shared/helper.py", "");
    await write("bad name/harbor.yaml", "");
    await write("bad name/tasks/t/task.toml", "");
    const shared = await hashTaskDir(path.join(root, "a/tasks/shared"));
    const missingVersions = vi.fn(
      async (dataset: string, versions: { task: string; hash: string }[]) =>
        // Laminar has a/shared only.
        versions.filter((v) => !(dataset === "a" && v.task === "shared")),
    );
    const client = {
      evalDatasets: { missingVersions },
    } as unknown as LaminarClient;

    const tasks = await remoteTaskVersions(
      client,
      root,
      ["a", "b", "bad name"],
      {},
    );
    expect(tasks.downloads).toEqual({ a: { shared }, b: {} });
    expect(Object.keys(tasks.taskHashes)).toEqual(["a", "b"]);
    expect(tasks.taskHashes.a.shared).toBe(shared);
    expect(missingVersions).toHaveBeenCalledTimes(2);

    const { index } = await packEvalsDir(
      root,
      "linux",
      remoteExclude(
        ["a", "b", "bad name", "other"],
        ["a", "b", "bad name"],
        {},
        tasks.downloads,
      ),
    );
    expect(index.map((f) => f.path).sort()).toEqual([
      "a/harbor.yaml",
      "a/lmnr.yaml",
      "a/tasks/own/environment/Dockerfile",
      "a/tasks/own/task.toml",
      "b/harbor.yaml",
      "b/lmnr.yaml",
      "b/tasks/shared/task.toml",
      "bad name/harbor.yaml",
      "bad name/tasks/t/task.toml",
      "shared/helper.py",
    ]);

    // --task leaves the other tasks out of the hashes and the upload.
    const own = await remoteTaskVersions(client, root, ["a"], {
      tasks: ["own"],
    });
    expect(Object.keys(own.taskHashes.a)).toEqual(["own"]);
    const { index: ownIndex } = await packEvalsDir(
      root,
      "linux",
      remoteExclude(
        ["a", "b", "bad name", "other"],
        ["a"],
        { tasks: ["own"] },
        own.downloads,
      ),
    );
    expect(ownIndex.map((f) => f.path).sort()).toEqual([
      "a/harbor.yaml",
      "a/lmnr.yaml",
      "a/tasks/own/environment/Dockerfile",
      "a/tasks/own/task.toml",
      "shared/helper.py",
    ]);
  });

  void it("uploads every task when Laminar has no dataset storage", async () => {
    await writeEvals();
    const client = {
      evalDatasets: {
        missingVersions: async () => {
          throw Object.assign(new Error("501"), {
            name: "LaminarApiError",
            code: "storage_not_configured",
          });
        },
      },
    } as unknown as LaminarClient;
    const tasks = await remoteTaskVersions(client, root, ["a"], {});
    expect(tasks.downloads).toEqual({ a: {} });
  });

  void it("passes the dataset and its task hashes to the plugin", async () => {
    await writeEvals();
    await write("bad name/harbor.yaml", "datasets:\n  - path: tasks\n");
    const seen: { args: string[]; hashes?: unknown }[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const pk = args.find((a) => a.startsWith("task_hashes_file="));
      seen.push({
        args,
        hashes: pk
          ? JSON.parse(await readFile(pk.split("=")[1], "utf8"))
          : undefined,
      });
      return 0;
    });

    await runDatasets(root, ["a", "bad name"], {}, {}, undefined, {
      taskHashes: { b: {} },
    });
    expect(seen[0].args).toContain("dataset=a");
    expect(seen[0].hashes).toEqual({
      own: await hashTaskDir(path.join(root, "a/tasks/own")),
      shared: await hashTaskDir(path.join(root, "a/tasks/shared")),
    });
    // Not a valid dataset name: grouped by it, but no dataset or hashes.
    expect(seen[1].args).toContain("group_name=bad name");
    expect(seen[1].args.some((a) => a.startsWith("dataset="))).toBe(false);
    expect(seen[1].hashes).toBeUndefined();
  });
});

void describe("handleEvalOrchestrate", () => {
  void it("fails clearly without a usable LMNR_EVAL_RUN", async () => {
    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      code: "missing_env",
      message: "LMNR_EVAL_RUN is not set.",
    });
    process.env.LMNR_EVAL_RUN = "{not json";
    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      code: "missing_env",
      message: expect.stringMatching(/^LMNR_EVAL_RUN is not valid JSON/),
    });
    process.env.LMNR_EVAL_RUN = "{}";
    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      message: expect.stringMatching(/not a run spec/),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  void it("sends Harbor's output and the failure to the run's log", async () => {
    await writeEvals();
    const marker = path.join(root, "log-started");
    // b/tasks/pulled is in Laminar: the run downloads it first.
    await write("src/pulled/task.toml", "[task]\n");
    const pulled = await packTaskDir(path.join(root, "src/pulled"));
    served.set(pulled.hash, pulled.archive);
    process.env.LMNR_EVAL_RUN = JSON.stringify({
      datasets: ["b"],
      overrides: {},
      env: {},
      images: {},
      dockerfiles: { b: {} },
      downloads: { b: { pulled: pulled.hash } },
      taskHashes: { b: { pulled: pulled.hash } },
    });
    process.env.LMNR_EVAL_UPLOAD_ID = "up-1";
    process.env.LMNR_RUN_LOG_MARKER = marker;
    process.env.LMNR_PROJECT_API_KEY = "run-key";
    let columns: string | undefined;
    let hashesFile: string | undefined;
    let downloaded = false;
    vi.mocked(runCommand).mockImplementation(async (_command, args, opts) => {
      columns = opts?.env?.COLUMNS;
      downloaded = existsSync(path.join(root, "b/tasks/pulled/task.toml"));
      const pk = args.find((a) => a.startsWith("task_hashes_file="));
      hashesFile = pk && (await readFile(pk.split("=")[1], "utf8"));
      opts?.output?.stdout.write(
        "trial 1/1 done\nResults written to /tmp/job/result.json\n" +
          "2026-11-13 18:39:22,645::lmnr.integrations.harbor.plugin::INFO: " +
          "Laminar evaluation: https://lmnr.test/e/1 (plugin.py:200)\npartial",
      );
      opts?.output?.stdout.end();
      return 1;
    });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);

    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      code: "harbor_failed",
    });
    cwd.mockRestore();

    // Harbor's unfinished last line goes out when its stream ends, before the
    // error, not with whatever is written after it.
    const harbor = appended.indexOf("trial 1/1 done");
    expect(appended.slice(harbor, harbor + 3)).toEqual([
      "trial 1/1 done",
      "Laminar evaluation for dataset b: https://lmnr.test/e/1",
      "partial",
    ]);
    expect(columns).toBe("500");
    expect(downloaded).toBe(true);
    expect(JSON.parse(hashesFile ?? "{}")).toEqual({ pulled: pulled.hash });
    expect(appended.findIndex((t) => t.startsWith("ERROR: "))).toBeGreaterThan(
      harbor + 1,
    );
    expect(existsSync(marker)).toBe(true);
  });
});
