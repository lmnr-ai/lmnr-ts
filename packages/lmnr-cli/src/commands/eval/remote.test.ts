import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imagePusher } from "./docker";
import { runDatasets } from "./harbor";
import type { ImageDef } from "./images";
import { handleEvalOrchestrate, startRemoteRun } from "./remote";
import { runCommand } from "./run-command";

vi.mock("./docker", () => ({ imagePusher: vi.fn() }));
vi.mock("./run-command", () => ({ runCommand: vi.fn() }));

const appended = vi.hoisted(() => [] as string[]);
vi.mock("@lmnr-ai/client", () => ({
  LaminarClient: class {
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

/** Two datasets sharing `app-evals`; dataset `a` also has its own Dockerfile. */
const writeEvals = async () => {
  for (const dataset of ["a", "b"]) {
    await write(
      `${dataset}/lmnr.yaml`,
      "images:\n  app-evals:\n    dockerfile: ../image/Dockerfile\n",
    );
    await write(`${dataset}/harbor.yaml`, "environment:\n  type: docker\n");
    await write(
      `${dataset}/tasks/shared/task.toml`,
      '[environment]\ndocker_image = "app-evals"\n',
    );
  }
  await write("a/tasks/own/task.toml", "");
  await write("a/tasks/own/environment/Dockerfile", "FROM alpine");
};

const IMAGES = {
  a: {
    images: { "app-evals": "sha256:app-evals" },
    dockerfiles: { "tasks/own/environment": "sha256:a/tasks/own/environment" },
  },
  b: { images: { "app-evals": "sha256:app-evals" }, dockerfiles: {} },
};

const RUNS = [
  { path: "a", group: "a v3" },
  { path: "b", group: "b unversioned" },
];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-remote-"));
});

afterEach(async () => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(imagePusher).mockReset();
  appended.length = 0;
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
  void it("sends each dataset's group and image digests", async () => {
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
    } as unknown as LaminarClient;

    const started = await startRemoteRun(
      client,
      root,
      RUNS,
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
        datasets: RUNS,
        overrides: { nAttempts: 2 },
        env: { OPENAI_API_KEY: "sk" },
        images: IMAGES,
      },
    });
  });
});

void describe("runDatasets", () => {
  void it("runs each dataset in its group, with its own LMNR_EVAL_IMAGES", async () => {
    await writeEvals();
    const seen: { cwd?: string; images?: string; group?: string }[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args, opts) => {
      const config = JSON.parse(
        await readFile(args[args.indexOf("-c") + 1], "utf8"),
      );
      expect(config.datasets).toEqual([{ path: "tasks" }]);
      seen.push({
        cwd: opts?.cwd,
        images: opts?.env?.LMNR_EVAL_IMAGES,
        group: args[args.indexOf("--pk") + 1],
      });
      return 0;
    });

    expect(await runDatasets(root, RUNS, {}, {}, IMAGES)).toEqual([]);
    expect(seen.map((s) => [s.cwd, s.group])).toEqual([
      [path.join(root, "a"), "group_name=a v3"],
      [path.join(root, "b"), "group_name=b unversioned"],
    ]);
    expect(seen.map((s) => JSON.parse(s.images ?? "null"))).toEqual([
      IMAGES.a,
      IMAGES.b,
    ]);

    seen.length = 0;
    const before: string[] = [];
    expect(
      await runDatasets(root, [RUNS[1]], {}, {}, undefined, {
        before: async (dataset) => {
          before.push(dataset);
        },
      }),
    ).toEqual([]);
    expect(before).toEqual(["b"]);
    expect(seen).toEqual([
      {
        cwd: path.join(root, "b"),
        images: undefined,
        group: "group_name=b unversioned",
      },
    ]);
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

    expect(await runDatasets(root, RUNS, {}, {}, IMAGES, { jobs })).toEqual([
      "a",
    ]);
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
    process.env.LMNR_EVAL_RUN = JSON.stringify({
      datasets: [{ path: "b", group: "b v1" }],
      overrides: {},
      env: {},
      images: { b: { images: {}, dockerfiles: {} } },
    });
    process.env.LMNR_EVAL_UPLOAD_ID = "up-1";
    process.env.LMNR_RUN_LOG_MARKER = marker;
    process.env.LMNR_PROJECT_API_KEY = "run-key";
    let columns: string | undefined;
    vi.mocked(runCommand).mockImplementation(async (_command, _args, opts) => {
      columns = opts?.env?.COLUMNS;
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
    expect(appended.findIndex((t) => t.startsWith("ERROR: "))).toBeGreaterThan(
      harbor + 1,
    );
    expect(existsSync(marker)).toBe(true);
  });
});
