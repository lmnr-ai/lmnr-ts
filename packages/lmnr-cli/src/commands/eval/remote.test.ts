import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { gunzipSync } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { unpackTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imagePusher } from "./docker";
import { SANDBOX_PROXY_PLACEHOLDER } from "./env";
import { type EvalDescription, setEvalDescription } from "./eval-py";
import { assertDatasetsPassed, runDatasets } from "./harbor";
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
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ initializeLogger: () => logger }));

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

/** The describe fields these tests don't look at. */
const DESCRIBED = {
  modules: [],
  artifacts: [],
  services: [],
  classes: [],
  mocks: [],
  mock_dependencies: [],
  laminar_layer: { python: "3.13", lmnr: "lmnr==0.9.3", build_contexts: {} },
};

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/**
 * Two datasets (acme/a, acme/b) using `app-evals`; dataset `a` also has its
 * own Dockerfile.
 */
const writeEvals = async () => {
  for (const dataset of ["a", "b"]) {
    await write(
      `${dataset}/harbor.yaml`,
      "images:\n  app-evals:\n    dockerfile: ../image/Dockerfile\n" +
        "environment:\n  type: docker\ndatasets:\n  - path: tasks\n",
    );
    await write(
      `${dataset}/tasks/dataset.toml`,
      `[dataset]\nname = "acme/${dataset}"\n`,
    );
    await write(
      `${dataset}/tasks/shared/task.toml`,
      '[task]\nname = "acme/shared"\n' +
        '[environment]\ndocker_image = "app-evals"\n',
    );
  }
  await write("a/tasks/own/task.toml", '[task]\nname = "acme/own"\n');
  await write("a/tasks/own/environment/Dockerfile", "FROM alpine");
};

const hashed = async (dir: string) => ({
  name: `acme/${path.basename(dir)}`,
  hash: await hashTaskDir(path.join(root, dir)),
});

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
        downloads: {
          a: { dataset: "acme/a", tasks: [] },
          b: { dataset: "acme/b", tasks: [] },
        },
        taskHashes: {
          a: {
            own: await hashed("a/tasks/own"),
            shared: await hashed("a/tasks/shared"),
          },
          b: { shared: await hashed("b/tasks/shared") },
        },
      },
    });
  });

  void it("sends sandbox proxy placeholders as secretEnv, not in the spec", async () => {
    await writeEvals();
    vi.mocked(imagePusher).mockReturnValue({
      build: async (def: ImageDef) => `sha256:${def.name}`,
      pull: async (ref: string) => `sha256:${ref}`,
    });
    const startRun = vi.fn(async () => ({ sandboxId: "sb-1" }));
    const client = {
      hostedEvals: {
        upload: async () => ({ uploadId: "up-1" }),
        uploadIndex: async () => undefined,
        startRun,
      },
      evalDatasets: {
        missingVersions: async (_dataset: string, versions: unknown[]) =>
          versions,
      },
    } as unknown as LaminarClient;

    await startRemoteRun(
      client,
      root,
      ["a"],
      {},
      {
        ANTHROPIC_API_KEY: SANDBOX_PROXY_PLACEHOLDER,
        LMNR_PROJECT_API_KEY: SANDBOX_PROXY_PLACEHOLDER,
        MODEL: "claude",
      },
    );

    const [options] = startRun.mock.calls[0] as unknown as [
      { spec: { env: Record<string, string> }; secretEnv?: object },
    ];
    expect(options.spec.env).toEqual({ MODEL: "claude" });
    expect(options.secretEnv).toEqual({
      ANTHROPIC_API_KEY: SANDBOX_PROXY_PLACEHOLDER,
    });
  });
});

void describe("startRemoteRun with generated images", () => {
  void it("uploads each generated Dockerfile under agent/.generated", async () => {
    const text =
      "# Generated by lmnr.evals.\n# _shared/support.py:12 (SupportRunner)\n" +
      "FROM python:3.13-slim\nWORKDIR /app\n";
    await write("support/agent/eval.py", "");
    // A stale copy on disk is replaced, not packed twice.
    await write("support/agent/.generated/app.Dockerfile", "stale");
    await write("support/tasks/dataset.toml", '[dataset]\nname = "acme/s"\n');
    await write(
      "support/tasks/refund/task.toml",
      '[task]\nname = "acme/refund"\n[environment]\ndocker_image = "app"\n',
    );
    const runner: EvalDescription = {
      version: 1,
      runner: "SupportEval",
      images: {
        app: {
          kind: "generated",
          dockerfile_text: text,
          context: root,
          steps: [],
        },
        unused: {
          kind: "generated",
          dockerfile_text: "FROM b\n",
          context: root,
          steps: [],
        },
      },
      default_image: "app",
      model: null,
      env: {},
      secrets: [],
      new_task_toml: {},
      grade_with_test_sh: false,
      warnings: [],
      ...DESCRIBED,
    };
    setEvalDescription(path.join(root, "support"), runner);
    const before = await hashed("support/tasks/refund");
    vi.mocked(imagePusher).mockReturnValue({
      build: async (def: ImageDef) => `sha256:${def.name}`,
      pull: async (ref: string) => `sha256:${ref}`,
    });
    let archive: Buffer = Buffer.alloc(0);
    const startRun = vi.fn(async () => ({ sandboxId: "sb-1" }));
    const client = {
      hostedEvals: {
        upload: async (a: Buffer) => {
          archive = a;
          return { uploadId: "up-1" };
        },
        uploadIndex: async () => undefined,
        startRun,
      },
      evalDatasets: {
        missingVersions: async (_dataset: string, versions: unknown[]) =>
          versions,
      },
    } as unknown as LaminarClient;

    await startRemoteRun(client, root, ["support"], {}, {}, undefined, {
      support: runner,
    });

    const files = (await unpackTar(gunzipSync(archive))).filter((e) =>
      e.header.name.startsWith("support/agent/.generated/"),
    );
    // Only what the run's tasks use, as describe printed it.
    expect(files.map((e) => e.header.name)).toEqual([
      "support/agent/.generated/app.Dockerfile",
    ]);
    expect(Buffer.from(files[0].data ?? []).toString()).toBe(text);
    // Under agent/, not tasks/: no task hash moves.
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          images: { support: { app: "sha256:app" } },
          taskHashes: { support: { refund: before } },
        }),
      }),
    );
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

    expect(
      (await runDatasets(root, ["a", "b"], {}, {}, IMAGES)).failed,
    ).toEqual([]);
    expect(seen.map((s) => s.cwd)).toEqual([
      path.join(root, "a"),
      path.join(root, "b"),
    ]);
    expect(seen.map((s) => JSON.parse(s.images ?? "null"))).toEqual([
      { images: IMAGES.images.a, dockerfiles: IMAGES.dockerfiles.a },
      { images: IMAGES.images.b, dockerfiles: {} },
    ]);

    seen.length = 0;
    expect((await runDatasets(root, ["b"], {}, {})).failed).toEqual([]);
    expect(seen).toEqual([{ cwd: path.join(root, "b"), images: undefined }]);
  });

  void it("hands each dataset's job dir to onDatasetEnd, failed or not", async () => {
    await writeEvals();
    const configs: Record<string, unknown>[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const config = JSON.parse(
        await readFile(args[args.indexOf("-c") + 1], "utf8"),
      );
      configs.push(config);
      await mkdir(path.join(config.jobs_dir, "2026-11-27__10-00-00"), {
        recursive: true,
      });
      return configs.length === 1 ? 1 : 0;
    });
    const ended: (string | undefined)[][] = [];
    const jobs = {
      dir: path.join(root, "jobs-out"),
      onDatasetEnd: async (dataset: string, jobDir: string | undefined) => {
        ended.push([dataset, jobDir]);
      },
    };

    expect(
      (await runDatasets(root, ["a", "b"], {}, {}, IMAGES, { jobs })).failed,
    ).toEqual(["a"]);
    // The job keeps Harbor's name: the plugin names the evaluation after it.
    expect(configs.map((c) => [c.jobs_dir, c.job_name])).toEqual([
      [path.join(jobs.dir, "a"), undefined],
      [path.join(jobs.dir, "b"), undefined],
    ]);
    expect(ended).toEqual([
      ["a", path.join(jobs.dir, "a", "2026-11-27__10-00-00")],
      ["b", path.join(jobs.dir, "b", "2026-11-27__10-00-00")],
    ]);
  });
});

void describe("errored trials", () => {
  /** A `harbor run` that writes these trial results into its job dir. */
  const harborWriting =
    (byDataset: Record<string, Record<string, unknown>[]>, code = 0) =>
    async (_command: string, _args: string[], opts?: { cwd?: string }) => {
      const dataset = path.basename(opts?.cwd ?? "");
      for (const [i, result] of (byDataset[dataset] ?? []).entries()) {
        await write(
          `${dataset}/jobs/2026-11-27__10-00-00/t${i}__x/result.json`,
          JSON.stringify(result),
        );
      }
      return code;
    };
  const raised = (type: string, message: string) => ({
    exception_info: { exception_type: type, exception_message: message },
    verifier_result: null,
  });
  const graded = {
    exception_info: null,
    verifier_result: { rewards: { r: 1 } },
  };

  void it("fails with 23 when every trial of a dataset errored, after every dataset ran", async () => {
    await writeEvals();
    vi.mocked(runCommand).mockImplementation(
      harborWriting({
        a: [
          raised("RuntimeError", "app never started\nTraceback"),
          raised("X", "y"),
        ],
        b: [graded, raised("AgentTimeoutError", "slow")],
      }),
    );

    const outcome = await runDatasets(root, ["a", "b"], {}, {});
    expect(outcome.failed).toEqual([]);
    const jobDir = path.join(root, "a/jobs/2026-11-27__10-00-00");
    expect(outcome.trials).toEqual({
      a: {
        total: 2,
        errored: 2,
        firstError: {
          type: "RuntimeError",
          message: "app never started\nTraceback",
        },
        jobDir,
      },
      b: expect.objectContaining({ total: 2, errored: 1 }),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Dataset a: 2/2 trials errored (first: RuntimeError: app never started)",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Dataset b: 1/2 trials errored (first: AgentTimeoutError: slow)",
    );
    expect(() => assertDatasetsPassed(outcome)).toThrow(
      expect.objectContaining({
        code: "trials_errored",
        exitCode: 23,
        message:
          "Every trial errored, so nothing was graded, in: a (2 trials; " +
          "first: RuntimeError: app never started; each trial's " +
          `exception.txt in ${jobDir})`,
      }),
    );
    // Only some errored: a warning, not a failure.
    expect(() =>
      assertDatasetsPassed({ failed: [], trials: { b: outcome.trials.b } }),
    ).not.toThrow();
  });

  void it("keeps Harbor's own failure first and counts no job as no trials", async () => {
    await writeEvals();
    vi.mocked(runCommand).mockImplementation(
      harborWriting({ a: [raised("X", "y")] }, 2),
    );
    const outcome = await runDatasets(root, ["a", "b"], {}, {}, IMAGES);
    expect(outcome.failed).toEqual(["a", "b"]);
    // Remote trials' job dirs go with their sandbox: not named.
    expect(outcome.trials.a).toEqual({
      total: 1,
      errored: 1,
      firstError: { type: "X", message: "y" },
    });
    expect(outcome.trials.b).toEqual({ total: 0, errored: 0 });
    expect(() => assertDatasetsPassed(outcome)).toThrow(
      expect.objectContaining({ code: "harbor_failed", exitCode: 18 }),
    );
  });
});

void describe("remote tasks", () => {
  void it("uploads only the run's tasks Laminar doesn't have", async () => {
    await writeEvals();
    await write("other/tasks/dataset.toml", '[dataset]\nname = "acme/other"\n');
    await write("other/tasks/x/task.toml", "");
    await write("shared/helper.py", "");
    // No dataset.toml: not an eval dataset, uploaded whole.
    await write("local only/harbor.yaml", "");
    await write("local only/tasks/t/task.toml", "");
    const shared = await hashTaskDir(path.join(root, "a/tasks/shared"));
    const missingVersions = vi.fn(
      async (dataset: string, versions: { task: string; hash: string }[]) =>
        // Laminar has acme/a's acme/shared only.
        versions.filter(
          (v) => !(dataset === "acme/a" && v.task === "acme/shared"),
        ),
    );
    const client = {
      evalDatasets: { missingVersions },
    } as unknown as LaminarClient;

    const tasks = await remoteTaskVersions(
      client,
      root,
      ["a", "b", "local only"],
      {},
    );
    expect(tasks.downloads).toEqual({
      a: {
        dataset: "acme/a",
        tasks: [{ task: "acme/shared", hash: shared, dir: "shared" }],
      },
      b: { dataset: "acme/b", tasks: [] },
    });
    expect(Object.keys(tasks.taskHashes)).toEqual(["a", "b"]);
    expect(tasks.taskHashes.a.shared).toEqual({
      name: "acme/shared",
      hash: shared,
    });
    expect(missingVersions).toHaveBeenCalledTimes(2);

    const { index } = await packEvalsDir(
      root,
      "linux",
      remoteExclude(
        ["a", "b", "local only", "other"],
        ["a", "b", "local only"],
        {},
        tasks.downloads,
      ),
    );
    expect(index.map((f) => f.path).sort()).toEqual([
      "a/harbor.yaml",
      "a/tasks/dataset.toml",
      "a/tasks/own/environment/Dockerfile",
      "a/tasks/own/task.toml",
      "b/harbor.yaml",
      "b/tasks/dataset.toml",
      "b/tasks/shared/task.toml",
      "local only/harbor.yaml",
      "local only/tasks/t/task.toml",
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
        ["a", "b", "local only", "other"],
        ["a"],
        { tasks: ["own"] },
        own.downloads,
      ),
    );
    expect(ownIndex.map((f) => f.path).sort()).toEqual([
      "a/harbor.yaml",
      "a/tasks/dataset.toml",
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
    expect(tasks.downloads).toEqual({ a: { dataset: "acme/a", tasks: [] } });
  });

  void it("passes the dataset and its task hashes to the plugin", async () => {
    await writeEvals();
    await write("local only/harbor.yaml", "datasets:\n  - path: tasks\n");
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

    await runDatasets(root, ["a", "local only"], {}, {}, undefined, {
      taskHashes: { b: {} },
    });
    expect(seen[0].args).toContain("group_name=acme/a");
    expect(seen[0].args).toContain("dataset=acme/a");
    expect(seen[0].hashes).toEqual({
      own: await hashed("a/tasks/own"),
      shared: await hashed("a/tasks/shared"),
    });
    // No dataset.toml: grouped by the folder, but no dataset or hashes.
    expect(seen[1].args).toContain("group_name=local only");
    expect(seen[1].args.some((a) => a.startsWith("dataset="))).toBe(false);
    expect(seen[1].hashes).toBeUndefined();
  });

  void it("groups the run by --group instead of the dataset name", async () => {
    await writeEvals();
    const seen: string[][] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      seen.push(args);
      return 0;
    });
    await runDatasets(root, ["a"], { group: "acme/a (prompt v2)" }, {});
    expect(seen[0]).toContain("group_name=acme/a (prompt v2)");
    // Still linked to its dataset.
    expect(seen[0]).toContain("dataset=acme/a");
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
    await write("src/pulled/task.toml", '[task]\nname = "acme/pulled"\n');
    const pulled = await packTaskDir(path.join(root, "src/pulled"));
    served.set(pulled.hash, pulled.archive);
    const hashes = { pulled: { name: "acme/pulled", hash: pulled.hash } };
    process.env.LMNR_EVAL_RUN = JSON.stringify({
      datasets: ["b"],
      overrides: {},
      env: {},
      images: {},
      dockerfiles: { b: {} },
      downloads: {
        b: {
          dataset: "acme/b",
          tasks: [{ task: "acme/pulled", hash: pulled.hash, dir: "pulled" }],
        },
      },
      taskHashes: { b: hashes },
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
    expect(JSON.parse(hashesFile ?? "{}")).toEqual(hashes);
    expect(appended.findIndex((t) => t.startsWith("ERROR: "))).toBeGreaterThan(
      harbor + 1,
    );
    expect(existsSync(marker)).toBe(true);
  });

  void it("builds an eval.py dataset's job from the spec's runner", async () => {
    await write(
      "support/agent/eval.py",
      '# /// script\n# dependencies = ["x"]\n# ///\n',
    );
    await write(
      "support/tasks/refund/task.toml",
      '[task]\nname = "a/refund"\n',
    );
    const runner: EvalDescription = {
      version: 1,
      runner: "SupportEval",
      images: {
        py: {
          kind: "generated",
          dockerfile_text: "FROM python:3.13\n",
          context: root,
          steps: [],
        },
      },
      default_image: "py",
      model: null,
      env: {},
      secrets: [],
      new_task_toml: {},
      grade_with_test_sh: false,
      warnings: ['services["postgres"] uses version "latest"'],
      ...DESCRIBED,
    };
    process.env.LMNR_EVAL_RUN = JSON.stringify({
      datasets: ["support"],
      overrides: {},
      env: {},
      images: {},
      dockerfiles: {},
      downloads: {},
      taskHashes: {},
      runners: { support: runner },
    });
    process.env.LMNR_PROJECT_API_KEY = "run-key";
    process.env.LMNR_EVAL_UPLOAD_ID = "up-1";
    let args: string[] = [];
    let job: Record<string, unknown> = {};
    vi.mocked(runCommand).mockImplementation(async (_command, a) => {
      args = a;
      job = JSON.parse(await readFile(a[a.indexOf("-c") + 1], "utf8"));
      return 0;
    });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      await handleEvalOrchestrate();
    } finally {
      cwd.mockRestore();
    }
    expect(args).toEqual(expect.arrayContaining(["--with", "x"]));
    // Describe's warnings are logged on every run, not only at describe time.
    expect(logger.warn).toHaveBeenCalledWith(
      'support/agent/eval.py: services["postgres"] uses version "latest"',
    );
    expect(job.agents).toEqual([
      expect.objectContaining({
        import_path: "lmnr.integrations.harbor.runner:LaminarAgent",
        kwargs: { runner: "agent/eval.py:SupportEval" },
      }),
    ]);
  });
});
