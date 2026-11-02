import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { packTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { imagePusher } from "./docker";
import { runCommand } from "./run-command";

vi.mock("./run-command", () => ({ runCommand: vi.fn() }));

const DIGEST = `sha256:${"c".repeat(64)}`;

let root: string;

interface DockerCall {
  args: string[];
  /** For `docker build`: the `-f` Dockerfile and its ignore file, as built. */
  dockerfile?: string;
  dockerignore?: string;
}

let calls: DockerCall[];

/** A `docker save` archive of a one-layer linux/amd64 image. */
const savedImageTar = () => {
  const entry = (name: string, body: string) => ({
    header: { name, size: Buffer.byteLength(body) },
    body,
  });
  return packTar([
    entry(
      "manifest.json",
      JSON.stringify([{ Config: "config.json", Layers: ["layer.tar"] }]),
    ),
    entry(
      "config.json",
      JSON.stringify({
        architecture: "amd64",
        rootfs: { type: "layers", diff_ids: [`sha256:${"a".repeat(64)}`] },
      }),
    ),
    entry("layer.tar", "plain layer tar"),
  ]);
};

/** Docker that succeeds; `docker save` writes {@link savedImageTar}. */
const fakeDocker = (buildExit = 0) =>
  vi.mocked(runCommand).mockImplementation(async (_command, args) => {
    const call: DockerCall = { args };
    calls.push(call);
    if (args[0] === "build") {
      const dockerfile = args[args.indexOf("-f") + 1] as string;
      call.dockerfile = await readFile(dockerfile, "utf8");
      call.dockerignore = await readFile(`${dockerfile}.dockerignore`, "utf8");
      return buildExit;
    }
    if (args[0] === "save") {
      await writeFile(args[2] as string, await savedImageTar());
    }
    return 0;
  });

const fakeClient = () =>
  ({
    hostedEvals: {
      missingLayers: async () => [],
      uploadLayer: async () => ({ digest: "sha256:x", size: 1 }),
      createImage: async () => ({ image: DIGEST }),
    },
  }) as unknown as LaminarClient;

const tempDirOf = (args: string[], flag: string) =>
  path.dirname(args[args.indexOf(flag) + 1] as string);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-docker-"));
  calls = [];
});

afterEach(async () => {
  vi.mocked(runCommand).mockReset();
  await rm(root, { recursive: true, force: true });
});

void describe("imagePusher", () => {
  void it("builds for linux/amd64 from the real context, saves and pushes", async () => {
    await mkdir(path.join(root, "app"));
    await writeFile(path.join(root, "app/Dockerfile"), "FROM alpine\n");
    fakeDocker();

    const digest = await imagePusher(fakeClient()).build({
      name: "app-evals",
      dockerfile: path.join(root, "app/Dockerfile"),
      context: path.join(root, "app"),
    });

    expect(digest).toBe(DIGEST);
    const [build, save] = calls;
    const tag = build?.args[build.args.indexOf("-t") + 1];
    expect(tag).toMatch(/^lmnr-evals-remote:[0-9a-f]{16}$/);
    expect(build?.args).toEqual([
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      expect.stringMatching(/Dockerfile$/),
      "-t",
      tag,
      path.join(root, "app"),
    ]);
    expect(build?.dockerfile).toBe("FROM alpine\n");
    expect(build?.dockerignore).toMatch(/^# Added by lmnr-cli\n\.git\n/);
    expect(save?.args).toEqual(["save", "-o", expect.any(String), tag]);
    // Both temp dirs are gone: the guarded Dockerfile's and the save's.
    expect(existsSync(tempDirOf(build?.args ?? [], "-f"))).toBe(false);
    expect(existsSync(tempDirOf(save?.args ?? [], "-o"))).toBe(false);
  });

  void it("pulls with a FROM-only build in one temp dir", async () => {
    fakeDocker();

    const digest = await imagePusher(fakeClient()).pull("python:3.12-slim");

    expect(digest).toBe(DIGEST);
    const [build, save] = calls;
    const dir = tempDirOf(build?.args ?? [], "-f");
    const tag = build?.args[build.args.indexOf("-t") + 1];
    expect(build?.args).toEqual([
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      path.join(dir, "Dockerfile"),
      "-t",
      tag,
      dir,
    ]);
    expect(build?.dockerfile).toBe("FROM python:3.12-slim\n");
    expect(save?.args[3]).toBe(tag);
    expect(existsSync(dir)).toBe(false);
  });

  void it("fails as docker_failed, naming the image, and cleans up", async () => {
    fakeDocker(1);

    await expect(
      imagePusher(fakeClient()).pull("python:3.12-slim"),
    ).rejects.toMatchObject({
      code: "docker_failed",
      exitCode: 20,
      message: "docker pull of python:3.12-slim failed (exit 1).",
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(tempDirOf(calls[0]?.args ?? [], "-f"))).toBe(false);
  });
});
