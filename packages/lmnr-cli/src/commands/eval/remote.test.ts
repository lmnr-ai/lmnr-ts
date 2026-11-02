import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imagePusher } from "./docker";
import { runSuites } from "./harbor";
import type { ImageDef } from "./images";
import { handleEvalOrchestrate, startRemoteRun } from "./remote";
import { runCommand } from "./run-command";

vi.mock("./docker", () => ({ imagePusher: vi.fn() }));
vi.mock("./run-command", () => ({ runCommand: vi.fn() }));

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** Two suites sharing `app-evals`; suite `a` also has its own Dockerfile. */
const writeEvals = async () => {
  await write(
    "lmnr.yaml",
    "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n",
  );
  for (const suite of ["a", "b"]) {
    await write(
      `${suite}/harbor.yaml`,
      "environment:\n  type: docker\ndatasets:\n  - path: tasks\n",
    );
    await write(
      `${suite}/tasks/shared/task.toml`,
      '[environment]\ndocker_image = "app-evals"\n',
    );
  }
  await write("a/tasks/own/task.toml", "");
  await write("a/tasks/own/environment/Dockerfile", "FROM alpine");
};

const IMAGES = {
  images: { "app-evals": "sha256:app-evals" },
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
  delete process.env.LMNR_EVAL_RUN;
  await rm(root, { recursive: true, force: true });
});

void describe("startRemoteRun", () => {
  void it("sends one image map and per-suite Dockerfile digests", async () => {
    await writeEvals();
    vi.mocked(imagePusher).mockReturnValue({
      build: async (def: ImageDef) => `sha256:${def.name}`,
      pull: async (ref: string) => `sha256:${ref}`,
    });
    const startRun = vi.fn(async () => ({ sandboxId: "sb-1" }));
    const client = {
      hostedEvals: { upload: async () => ({ uploadId: "up-1" }), startRun },
    } as unknown as LaminarClient;

    const started = await startRemoteRun(
      client,
      root,
      ["a", "b"],
      { nAttempts: 2 },
      { OPENAI_API_KEY: "sk", LMNR_PROJECT_API_KEY: "dropped" },
    );

    expect(started).toEqual({ uploadId: "up-1", sandboxId: "sb-1" });
    expect(startRun).toHaveBeenCalledWith({
      uploadId: "up-1",
      cliVersion: expect.any(String),
      spec: {
        suites: ["a", "b"],
        overrides: { nAttempts: 2 },
        env: { OPENAI_API_KEY: "sk" },
        ...IMAGES,
      },
    });
  });
});

void describe("runSuites", () => {
  void it("gives each remote suite LMNR_EVAL_IMAGES with its own Dockerfiles", async () => {
    await writeEvals();
    const seen: { cwd?: string; images?: string }[] = [];
    vi.mocked(runCommand).mockImplementation(async (_command, _args, opts) => {
      seen.push({ cwd: opts?.cwd, images: opts?.env?.LMNR_EVAL_IMAGES });
      return 0;
    });

    expect(await runSuites(root, ["a", "b"], {}, {}, IMAGES)).toEqual([]);
    expect(seen.map((s) => s.cwd)).toEqual([
      path.join(root, "a"),
      path.join(root, "b"),
    ]);
    expect(seen.map((s) => JSON.parse(s.images ?? "null"))).toEqual([
      { images: IMAGES.images, dockerfiles: IMAGES.dockerfiles.a },
      { images: IMAGES.images, dockerfiles: {} },
    ]);

    seen.length = 0;
    expect(await runSuites(root, ["b"], {}, {})).toEqual([]);
    expect(seen).toEqual([{ cwd: path.join(root, "b"), images: undefined }]);
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
});
