import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { imagePusher } from "./docker";
import { runTaskSets, type TaskSetRun } from "./harbor";
import type { ImageDef } from "./images";
import { type Exclude, packFiles, walkFiles } from "./pack";
import {
  handleEvalOrchestrate,
  type PreparedAgent,
  startRemoteRun,
} from "./remote";
import { runCommand } from "./run-command";
import { AGENT_SCRIPTS } from "./store";

vi.mock("./docker", () => ({ imagePusher: vi.fn() }));
vi.mock("./run-command", () => ({ runCommand: vi.fn() }));

const appended = vi.hoisted(() => [] as string[]);
/** Blob archives by hash, served by the mocked client. */
const blobs = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("@lmnr-ai/client", () => ({
  LaminarClient: class {
    hostedEvals = {
      appendRunLogs: async (_id: string, lines: { text: string }[]) => {
        appended.push(...lines.map((l) => l.text));
        return true;
      },
      uploadJob: async () => undefined,
      uploadJobIndex: async () => undefined,
      getBlob: async (hash: string) =>
        new Blob([new Uint8Array(blobs.get(hash) as Buffer)]).stream(),
    };
  },
}));

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** An agent with one image and two task sets. */
const writeAgent = async () => {
  await write(
    "evals/support/agent.yaml",
    "images:\n  app:\n    dockerfile: environment/Dockerfile\n" +
      "job:\n  environment:\n    type: docker\n",
  );
  await write("evals/support/environment/Dockerfile", "FROM alpine");
  for (const set of ["a", "b"]) {
    await write(
      `evals/support/task_sets/${set}/shared/task.toml`,
      '[environment]\ndocker_image = "app"\n',
    );
  }
  await write(
    "evals/support/task_sets/a/public/task.toml",
    '[environment]\ndocker_image = "python:3.12-slim"\n',
  );
};

const agentDir = () => path.join(root, "evals/support");

const prepared = (): PreparedAgent => ({
  agent: { name: "support", versionId: "av-1", hash: "agent-hash" },
  dir: agentDir(),
  taskSets: ["a", "b"].map((name) => ({
    name,
    versionId: `tv-${name}`,
    hash: `${name}-hash`,
    dir: path.join(agentDir(), "task_sets", name),
  })),
});

const runs = (): TaskSetRun[] =>
  prepared().taskSets.map((set) => ({
    agent: "support",
    agentDir: agentDir(),
    agentVersionId: "av-1",
    job: {},
    taskSet: set.name,
    setDir: set.dir,
    taskSetVersionId: set.versionId,
  }));

const IMAGES = {
  images: {
    app: "sha256:app",
    "python:3.12-slim": "sha256:python:3.12-slim",
  },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-remote-"));
});

afterEach(async () => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(imagePusher).mockReset();
  vi.restoreAllMocks();
  appended.length = 0;
  blobs.clear();
  for (const key of [
    "LMNR_EVAL_RUN",
    "LMNR_EVAL_RUN_ID",
    "LMNR_EVALS_ROOT",
    "LMNR_RUN_LOG_MARKER",
    "LMNR_PROJECT_API_KEY",
  ]) {
    delete process.env[key];
  }
  await rm(root, { recursive: true, force: true });
});

void describe("startRemoteRun", () => {
  void it("pushes the agent's images and sends the versions in the spec", async () => {
    await writeAgent();
    vi.mocked(imagePusher).mockReturnValue({
      build: async (def: ImageDef) => `sha256:${def.name}`,
      pull: async (ref: string) => `sha256:${ref}`,
    });
    const startRun = vi.fn(async () => ({ runId: "run-1", sandboxId: "sb-1" }));
    const client = { hostedEvals: { startRun } } as unknown as LaminarClient;

    const started = await startRemoteRun(
      client,
      prepared(),
      { nAttempts: 2 },
      { OPENAI_API_KEY: "sk", LMNR_PROJECT_API_KEY: "dropped" },
    );

    expect(started).toEqual({ runId: "run-1", sandboxId: "sb-1" });
    expect(startRun).toHaveBeenCalledWith({
      cliVersion: expect.any(String),
      spec: {
        agent: { name: "support", versionId: "av-1", hash: "agent-hash" },
        taskSets: [
          { name: "a", versionId: "tv-a", hash: "a-hash" },
          { name: "b", versionId: "tv-b", hash: "b-hash" },
        ],
        overrides: { nAttempts: 2 },
        env: { OPENAI_API_KEY: "sk" },
        ...IMAGES,
      },
    });
  });
});

void describe("runTaskSets", () => {
  void it("runs each task set from the agent dir, linked to its versions", async () => {
    await writeAgent();
    const seen: { cwd?: string; env?: NodeJS.ProcessEnv; args: string[] }[] =
      [];
    vi.mocked(runCommand).mockImplementation(async (_command, args, opts) => {
      seen.push({ cwd: opts?.cwd, env: opts?.env, args });
      return 0;
    });

    expect(
      await runTaskSets(runs(), {}, {}, IMAGES, { runId: "run-1" }),
    ).toEqual([]);
    expect(seen.map((s) => s.cwd)).toEqual([agentDir(), agentDir()]);
    const env = seen[1].env ?? {};
    expect(env).toMatchObject({
      LMNR_EVAL_AGENT_VERSION_ID: "av-1",
      LMNR_EVAL_TASK_SET_VERSION_ID: "tv-b",
      LMNR_EVAL_TASK_SET_ROOT: path.join(agentDir(), "task_sets/b"),
      LMNR_EVAL_RUN_ID: "run-1",
      HARBOR_LAMINAR_GROUP: "support/b",
    });
    expect(JSON.parse(env.LMNR_EVAL_IMAGES ?? "null")).toEqual(IMAGES);
    expect(seen[1].args).toContain("group_name=support/b");

    seen.length = 0;
    expect(await runTaskSets(runs().slice(0, 1), {}, {})).toEqual([]);
    expect(seen[0].env?.LMNR_EVAL_IMAGES).toBeUndefined();
    expect(seen[0].env?.LMNR_EVAL_RUN_ID).toBeUndefined();
  });

  void it("writes each task set's job where onTaskSetEnd reads it, failed or not", async () => {
    await writeAgent();
    const configs: Record<string, unknown>[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const config = args[args.indexOf("-c") + 1];
      configs.push(JSON.parse(await readFile(config, "utf8")));
      return configs.length === 1 ? 1 : 0;
    });
    const ended: string[][] = [];
    const jobs = {
      dir: path.join(root, "jobs-out"),
      onTaskSetEnd: async (taskSet: string, jobDir: string) => {
        ended.push([taskSet, jobDir]);
      },
    };

    expect(await runTaskSets(runs(), {}, {}, IMAGES, { jobs })).toEqual([
      "support/a",
    ]);
    // The job keeps Harbor's name: the plugin names the evaluation after it.
    expect(configs.map((c) => [c.jobs_dir, c.job_name])).toEqual([
      [path.join(jobs.dir, "a"), undefined],
      [path.join(jobs.dir, "b"), undefined],
    ]);
    expect(configs[1].datasets).toEqual([
      { path: path.join(agentDir(), "task_sets/b") },
    ]);
    expect(ended).toEqual([
      ["a", path.join(jobs.dir, "a")],
      ["b", path.join(jobs.dir, "b")],
    ]);
  });
});

void describe("handleEvalOrchestrate", () => {
  void it("fails clearly without a usable LMNR_EVAL_RUN or run id", async () => {
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
    process.env.LMNR_EVAL_RUN = JSON.stringify({ agent: {}, taskSets: [] });
    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      message: "LMNR_EVAL_RUN_ID is not set.",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  void it("downloads the run's versions, runs them and logs Harbor's output", async () => {
    await writeAgent();
    const blobOf = async (dir: string, exclude?: Exclude) =>
      (await packFiles((await walkFiles(dir, process.platform, exclude)).files))
        .archive;
    blobs.set("agent-hash", await blobOf(agentDir(), AGENT_SCRIPTS));
    blobs.set("b-hash", await blobOf(path.join(agentDir(), "task_sets/b")));
    const evalsRoot = path.join(root, "sandbox-evals");
    const marker = path.join(root, "log-started");
    process.env.LMNR_EVAL_RUN = JSON.stringify({
      agent: { name: "support", versionId: "av-1", hash: "agent-hash" },
      taskSets: [{ name: "b", versionId: "tv-b", hash: "b-hash" }],
      overrides: {},
      env: {},
      images: IMAGES.images,
    });
    process.env.LMNR_EVAL_RUN_ID = "run-1";
    process.env.LMNR_EVALS_ROOT = evalsRoot;
    process.env.LMNR_RUN_LOG_MARKER = marker;
    process.env.LMNR_PROJECT_API_KEY = "run-key";
    let env: NodeJS.ProcessEnv | undefined;
    let cwd: string | undefined;
    vi.mocked(runCommand).mockImplementation(async (_command, _args, opts) => {
      env = opts?.env;
      cwd = opts?.cwd;
      opts?.output?.stdout.write(
        "trial 1/1 done\nResults written to /tmp/job/result.json\n" +
          "2026-11-13 18:39:22,645::lmnr.integrations.harbor.plugin::INFO: " +
          "Laminar evaluation: https://lmnr.test/e/1 (plugin.py:200)\npartial",
      );
      opts?.output?.stdout.end();
      return 1;
    });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(handleEvalOrchestrate()).rejects.toMatchObject({
      code: "harbor_failed",
    });

    const agentRoot = path.join(evalsRoot, "support");
    expect(cwd).toBe(agentRoot);
    expect(
      existsSync(path.join(agentRoot, "task_sets/b/shared/task.toml")),
    ).toBe(true);
    expect(existsSync(path.join(agentRoot, "task_sets/a"))).toBe(false);
    expect(env).toMatchObject({
      COLUMNS: "500",
      LMNR_EVAL_RUN_ID: "run-1",
      LMNR_EVAL_TASK_SET_VERSION_ID: "tv-b",
      LMNR_EVAL_TASK_SET_ROOT: path.join(agentRoot, "task_sets/b"),
    });
    // Harbor's unfinished last line goes out when its stream ends, before the
    // error, not with whatever is written after it.
    const harbor = appended.indexOf("trial 1/1 done");
    expect(appended.slice(harbor, harbor + 3)).toEqual([
      "trial 1/1 done",
      "Laminar evaluation for task set support/b: https://lmnr.test/e/1",
      "partial",
    ]);
    expect(appended.findIndex((t) => t.startsWith("ERROR: "))).toBeGreaterThan(
      harbor + 1,
    );
    expect(existsSync(marker)).toBe(true);
  });
});
