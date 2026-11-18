import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { InvalidArgumentError } from "commander";
import { unpackTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildJobConfig,
  discoverDatasets,
  findTaskTomls,
  findTemplateVars,
  globToRegExp,
  LAMINAR_ENVIRONMENT_IMPORT_PATH,
  loadDatasetConfig,
  selectDatasets,
} from "./datasets";
import { guardedDockerfile } from "./docker";
import { laminarBaseUrl, parseEnvFlags, resolveTemplateEnv } from "./env";
import { HARBOR_VERSION, harborArgs, LMNR_PYTHON_VERSION } from "./harbor";
import {
  dockerfileKey,
  ensureRemoteImages,
  findTaskImages,
  type ImageDef,
  loadImageDefs,
  localImageDefs,
} from "./images";
import { assertRemotePassed, parsePositiveInt } from "./index";
import { packEvalsDir } from "./pack";

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const filesOf = async (archive: Buffer) =>
  (await unpackTar(gunzipSync(archive))).filter(
    (e) => e.header.type === "file",
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-evals-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("discoverDatasets / packEvalsDir", () => {
  void it("finds datasets and packs the folder's contents at the archive root", async () => {
    await write("hello/harbor.yaml", "agents: []");
    await write("hello/lmnr.yaml");
    await write("hello/lmnr.lock");
    await write("hello/tasks/hello-world/task.toml");
    await write("hello/tasks/.lmnr-state.json", "{}");
    await write("other/harbor.yaml");
    await write("notes/README.md");

    expect(await discoverDatasets(root)).toEqual(["hello", "other"]);
    const { archive, fileCount } = await packEvalsDir(root);
    expect(fileCount).toBe(6);
    const names = (await filesOf(archive)).map((e) => e.header.name).sort();
    // The sync state is local bookkeeping, never uploaded.
    expect(names).toEqual([
      "hello/harbor.yaml",
      "hello/lmnr.lock",
      "hello/lmnr.yaml",
      "hello/tasks/hello-world/task.toml",
      "notes/README.md",
      "other/harbor.yaml",
    ]);
  });

  void it("never uploads env files, VCS data, deps, caches or job output", async () => {
    await write("hello/harbor.yaml");
    await write(".env", "SECRET=1");
    await write("hello/.env.local", "SECRET=1");
    await write(".git/config");
    await write("hello/node_modules/pkg/index.js");
    await write("hello/.venv/bin/python");
    await write("hello/tasks/t/__pycache__/x.pyc");
    await write("hello/jobs/2026-10-28__12-00-00/result.json");
    await write("hello/tasks/t/environment/Dockerfile");

    const { archive } = await packEvalsDir(root);

    const names = (await filesOf(archive)).map((e) => e.header.name).sort();
    expect(names).toEqual([
      "hello/harbor.yaml",
      "hello/tasks/t/environment/Dockerfile",
    ]);
  });

  void it("keeps the executable bit and skips symlinks", async () => {
    await write("hello/harbor.yaml");
    await write("hello/tasks/t/tests/test.sh", "#!/bin/sh");
    await chmod(path.join(root, "hello/tasks/t/tests/test.sh"), 0o755);
    await symlink("/etc/passwd", path.join(root, "hello/passwd"));

    const { archive, skippedSymlinks } = await packEvalsDir(root);

    expect(skippedSymlinks).toEqual(["hello/passwd"]);
    const script = (await filesOf(archive)).find(
      (e) => e.header.name === "hello/tasks/t/tests/test.sh",
    );
    expect(script!.header.mode! & 0o111).toBe(0o111);
  });

  void it("indexes every file so it can be read from its gzip member alone", async () => {
    const big = Buffer.alloc(1536 * 1024, "b");
    const longName = `hello/${"deep/".repeat(30)}file.txt`;
    await write("hello/harbor.yaml", "agents: []");
    await write("hello/tasks/a/task.toml", "[task]");
    await write("hello/tasks/a/data.bin", big.toString());
    await write("hello/tasks/a/after-big.txt", "after");
    await write("hello/tasks/a/empty.txt", "");
    await write(longName, "long");

    const { archive, index } = await packEvalsDir(root);

    expect(index.map((f) => f.path)).toEqual(
      (await filesOf(archive)).map((e) => e.header.name),
    );
    for (const file of index) {
      const member = gunzipSync(
        archive.subarray(file.offset, file.offset + file.length),
      );
      const content = member.subarray(
        file.dataOffset,
        file.dataOffset + file.size,
      );
      expect(content).toEqual(await readFile(path.join(root, file.path)));
    }
    // Files of one directory share a member until it reaches 1 MiB.
    const offsets = Object.fromEntries(index.map((f) => [f.path, f.offset]));
    expect(offsets["hello/tasks/a/data.bin"]).toBe(
      offsets["hello/tasks/a/after-big.txt"],
    );
    expect(offsets["hello/tasks/a/empty.txt"]).not.toBe(
      offsets["hello/tasks/a/data.bin"],
    );
    expect(offsets["hello/harbor.yaml"]).not.toBe(
      offsets["hello/tasks/a/data.bin"],
    );
  });

  void it("marks shell scripts executable when packed on Windows", async () => {
    await write("hello/harbor.yaml");
    await write("hello/tasks/t/tests/test.sh", "#!/bin/sh");
    await chmod(path.join(root, "hello/tasks/t/tests/test.sh"), 0o644);

    const { archive } = await packEvalsDir(root, "win32");

    const modes = Object.fromEntries(
      (await filesOf(archive)).map((e) => [
        e.header.name,
        e.header.mode! & 0o777,
      ]),
    );
    expect(modes["hello/tasks/t/tests/test.sh"]).toBe(0o755);
    expect(modes["hello/harbor.yaml"]).toBe(0o644);
  });

  void it("rejects a folder without datasets at its root", async () => {
    await write("evals/hello/harbor.yaml");
    await expect(discoverDatasets(root)).rejects.toMatchObject({
      code: "invalid_evals_dir",
      exitCode: 16,
    });
    await expect(
      discoverDatasets(path.join(root, "missing")),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });

  void it("rejects a root lmnr.yaml: images are per dataset", async () => {
    await write("hello/harbor.yaml");
    await write("lmnr.yaml", "images: {}\n");
    await expect(discoverDatasets(root)).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(
        /Move its images into <dataset>\/lmnr.yaml/,
      ),
    });
  });

  void it("selects --dataset folders and rejects unknown ones", async () => {
    await write("a/harbor.yaml");
    await write("b/harbor.yaml");
    expect(await selectDatasets(root, undefined)).toEqual(["a", "b"]);
    expect(await selectDatasets(root, ["b", "b"])).toEqual(["b"]);
    await expect(selectDatasets(root, ["c"])).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(
        /Unknown --dataset c\. Datasets in .*: a, b/,
      ),
    });
  });
});

void describe("loadDatasetConfig", () => {
  void it("runs the dataset's tasks/ folder", async () => {
    await write("s/harbor.yaml", "n_attempts: 2\n");
    expect(await loadDatasetConfig(path.join(root, "s"))).toEqual({
      n_attempts: 2,
      datasets: [{ path: "tasks" }],
    });
    await write("e/harbor.yaml", "");
    expect(await loadDatasetConfig(path.join(root, "e"))).toEqual({
      datasets: [{ path: "tasks" }],
    });
  });

  void it("rejects a harbor.yaml that picks its own tasks", async () => {
    await write("s/harbor.yaml", "datasets:\n  - path: tasks\n");
    await expect(loadDatasetConfig(path.join(root, "s"))).rejects.toMatchObject(
      {
        code: "invalid_evals_dir",
        message: expect.stringMatching(/sets `datasets`: remove it/),
      },
    );
    await write("t/harbor.yaml", "tasks: []\ndatasets: []\n");
    await expect(loadDatasetConfig(path.join(root, "t"))).rejects.toMatchObject(
      {
        message: expect.stringMatching(
          /sets `datasets` and `tasks`: remove them/,
        ),
      },
    );
    await write("u/harbor.yaml", "- a\n");
    await expect(loadDatasetConfig(path.join(root, "u"))).rejects.toMatchObject(
      {
        message: expect.stringMatching(/must be a mapping/),
      },
    );
  });
});

void describe("buildJobConfig", () => {
  const base = {
    environment: { type: "docker", kwargs: { x: 1 }, env: { A: "1" } },
    agents: [{ import_path: "agent.agent:MyAgent", env: { K: "${K}" } }],
    datasets: [{ path: "tasks" }],
  };

  void it("routes remote trials to the Laminar environment", () => {
    const job = buildJobConfig(base, {}, true);
    expect(job.environment).toEqual({
      env: { A: "1" },
      import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH,
    });
    expect(base.environment.type).toBe("docker");
  });

  void it("leaves local runs on the dataset's environment", () => {
    expect(buildJobConfig(base, {}, false).environment).toEqual(
      base.environment,
    );
  });

  void it("applies attempts, concurrency, task filters, model and --env", () => {
    const job = buildJobConfig(
      base,
      {
        nAttempts: 3,
        nConcurrent: 8,
        tasks: ["al*"],
        model: "anthropic/claude-sonnet-5-5",
        extraAgentEnv: ["K", "EXTRA"],
      },
      false,
    );
    expect(job.n_attempts).toBe(3);
    expect(job.n_concurrent_trials).toBe(8);
    expect(job.datasets).toEqual([{ path: "tasks", task_names: ["al*"] }]);
    expect(base.datasets).toEqual([{ path: "tasks" }]);
    expect(job.agents).toEqual([
      {
        import_path: "agent.agent:MyAgent",
        model_name: "anthropic/claude-sonnet-5-5",
        env: { K: "${K}", EXTRA: "${EXTRA}" },
      },
    ]);
  });

  void it("materializes Harbor's default agent to apply a model", () => {
    expect(buildJobConfig({}, { model: "m" }, false).agents).toEqual([
      { name: "oracle", model_name: "m" },
    ]);
  });

  void it("matches task globs like fnmatch", () => {
    expect(globToRegExp("hello-*").test("hello-world")).toBe(true);
    expect(globToRegExp("case-?").test("case-12")).toBe(false);
    expect(globToRegExp("case-[!0-4]").test("case-7")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

void describe("template env", () => {
  void it("finds ${VAR} placeholders in harbor.yaml and task.toml", async () => {
    await write(
      "s/harbor.yaml",
      "agents:\n  - env:\n      OPENAI_API_KEY: ${OPENAI_API_KEY}\n      M: ${MODEL:-gpt}\n",
    );
    await write(
      "s/tasks/t/task.toml",
      '[verifier.env]\nJUDGE_KEY = "${JUDGE_KEY}"\n',
    );
    await write("s/jobs/old/task.toml", '[x]\nY = "${IGNORED}"\n');
    await write("s/tasks/other/task.toml", '[x]\nY = "${OTHER_KEY}"\n');

    const vars = await findTemplateVars(path.join(root, "s"), {});
    expect([...vars.required].sort()).toEqual([
      "JUDGE_KEY",
      "OPENAI_API_KEY",
      "OTHER_KEY",
    ]);
    expect([...vars.optional]).toEqual(["MODEL"]);

    // A task --task leaves out doesn't need its variables.
    const only = await findTemplateVars(path.join(root, "s"), { tasks: ["t"] });
    expect([...only.required].sort()).toEqual(["JUDGE_KEY", "OPENAI_API_KEY"]);
  });

  void it("resolves from the process env, then .env files, and lists missing ones", async () => {
    await write(".env", "FROM_FILE=file-value\nUNUSED=1\n");
    process.env.LMNR_TEST_FROM_ENV = "env-value";
    try {
      const { env, missing } = await resolveTemplateEnv(
        {
          required: new Set(["LMNR_TEST_FROM_ENV", "FROM_FILE", "NOPE"]),
          optional: new Set(["ALSO_NOPE"]),
        },
        root,
      );
      expect(env).toEqual({
        FROM_FILE: "file-value",
        LMNR_TEST_FROM_ENV: "env-value",
      });
      expect(missing).toEqual(["NOPE"]);
    } finally {
      delete process.env.LMNR_TEST_FROM_ENV;
    }
  });
});

void describe("images", () => {
  void it("reads lmnr.yaml images relative to the dataset folder", async () => {
    await write(
      "evals/s/lmnr.yaml",
      "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n    context: ../..\n  plain:\n    dockerfile: plain/Dockerfile\n",
    );
    const defs = await loadImageDefs(path.join(root, "evals/s"));
    expect(defs).toEqual([
      {
        name: "app-evals",
        dockerfile: path.join(root, "evals/s/image/Dockerfile"),
        context: root,
      },
      {
        name: "plain",
        dockerfile: path.join(root, "evals/s/plain/Dockerfile"),
        context: path.join(root, "evals/s/plain"),
      },
    ]);
    expect(await loadImageDefs(root)).toEqual([]);
  });

  void it("guards a build with the image's ignore rules plus .git and env files", async () => {
    await write("repo/Dockerfile", "FROM alpine\nCOPY . /app\n");
    await write("repo/.dockerignore", "data/\n!.env.example\n");
    const def = {
      name: "app",
      dockerfile: path.join(root, "repo/Dockerfile"),
      context: path.join(root, "repo"),
    };

    const dir = await guardedDockerfile(def);
    try {
      expect(await readFile(path.join(dir, "Dockerfile"), "utf8")).toBe(
        "FROM alpine\nCOPY . /app\n",
      );
      const rules = (
        await readFile(path.join(dir, "Dockerfile.dockerignore"), "utf8")
      ).split("\n");
      // The guard comes last, so the image's own `!` rules can't undo it.
      expect(rules.slice(0, 2)).toEqual(["data/", "!.env.example"]);
      expect(rules.slice(2)).toEqual([
        "# Added by lmnr-cli",
        ".git",
        "**/.git",
        ".env",
        ".env.*",
        "**/.env",
        "**/.env.*",
        "",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // A Dockerfile-specific ignore file wins over the context's, as in Docker.
    await write("repo/Dockerfile.dockerignore", "only-this/\n");
    const own = await guardedDockerfile(def);
    try {
      const rules = await readFile(
        path.join(own, "Dockerfile.dockerignore"),
        "utf8",
      );
      expect(rules.startsWith("only-this/\n# Added by lmnr-cli")).toBe(true);
    } finally {
      await rm(own, { recursive: true, force: true });
    }

    await expect(
      guardedDockerfile({ ...def, context: path.join(root, "missing") }),
    ).rejects.toThrow(/Build context not found/);
    await expect(
      guardedDockerfile({ ...def, dockerfile: path.join(root, "nope") }),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/Dockerfile not found/),
    });
  });

  void it("guards a build that has no ignore file of its own", async () => {
    await write("bare/Dockerfile", "FROM alpine\n");
    const dir = await guardedDockerfile({
      name: "bare",
      dockerfile: path.join(root, "bare/Dockerfile"),
      context: path.join(root, "bare"),
    });
    try {
      expect(
        await readFile(path.join(dir, "Dockerfile.dockerignore"), "utf8"),
      ).toBe(
        [
          "# Added by lmnr-cli",
          ".git",
          "**/.git",
          ".env",
          ".env.*",
          "**/.env",
          "**/.env.*",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it("finds per-task Dockerfiles and the docker_images tasks use", async () => {
    await write("s/harbor.yaml", "");
    await write("s/tasks/own/task.toml", "[environment]\ncpus = 1\n");
    await write("s/tasks/own/environment/Dockerfile", "FROM alpine");
    await write(
      "s/tasks/shared/task.toml",
      '[environment]\ndocker_image = "app-evals"\n',
    );
    await write("s/tasks/shared/environment/Dockerfile", "FROM alpine");
    await write(
      "s/tasks/public/task.toml",
      "[environment]\ndocker_image = 'python:3.12-slim'\n",
    );
    await write(
      "s/tasks/again/task.toml",
      '[environment]\ndocker_image = "app-evals"\n',
    );
    await write("s/tasks/data-only/task.toml", "");

    const found = await findTaskImages(path.join(root, "s"), {});
    expect(found.dockerfiles).toEqual([
      path.join(root, "s/tasks/own/environment"),
    ]);
    expect(found.images.sort()).toEqual(["app-evals", "python:3.12-slim"]);
  });

  void it("uses a task's own Dockerfile over its docker_image with force_build", async () => {
    await write("s/harbor.yaml", "environment:\n  force_build: true\n");
    await write(
      "s/tasks/shared/task.toml",
      '[environment]\ndocker_image = "app-evals"\n',
    );
    await write("s/tasks/shared/environment/Dockerfile", "FROM alpine");
    await write(
      "s/tasks/prebuilt/task.toml",
      '[environment]\ndocker_image = "python:3.12-slim"\n',
    );

    const found = await findTaskImages(path.join(root, "s"), {});
    expect(found.dockerfiles).toEqual([
      path.join(root, "s/tasks/shared/environment"),
    ]);
    // Without a Dockerfile the task still starts from its docker_image.
    expect(found.images).toEqual(["python:3.12-slim"]);
  });

  void it("builds referenced lmnr.yaml and per-task images, pulls the rest, each once", async () => {
    // Both datasets build app-evals from one Dockerfile; b's `other` is its own.
    for (const dataset of ["a", "b"]) {
      await write(
        `evals/${dataset}/lmnr.yaml`,
        "images:\n  app-evals:\n    dockerfile: ../image/Dockerfile\n" +
          "  unused:\n    dockerfile: unused/Dockerfile\n" +
          (dataset === "b"
            ? "  other:\n    dockerfile: other/Dockerfile\n"
            : ""),
      );
      await write(`evals/${dataset}/harbor.yaml`, "");
      await write(
        `evals/${dataset}/tasks/shared/task.toml`,
        '[environment]\ndocker_image = "app-evals"\n',
      );
      await write(
        `evals/${dataset}/tasks/public/task.toml`,
        '[environment]\ndocker_image = "python:3.12-slim"\n',
      );
    }
    await write(
      "evals/b/tasks/mine/task.toml",
      '[environment]\ndocker_image = "other"\n',
    );
    await write("evals/a/tasks/own/task.toml", "");
    await write("evals/a/tasks/own/environment/Dockerfile", "FROM alpine");
    const calls: string[] = [];
    const pusher = {
      build: async (def: ImageDef) => {
        calls.push(`build ${def.name} ${path.relative(root, def.context)}`);
        return `sha256:${def.name}`;
      },
      pull: async (ref: string) => {
        calls.push(`pull ${ref}`);
        return `sha256:${ref}`;
      },
    };

    const pushed = await ensureRemoteImages(
      path.join(root, "evals"),
      ["a", "b"],
      {},
      pusher,
    );
    // `unused` is in lmnr.yaml but no task references it: never built.
    expect(calls.sort()).toEqual([
      `build a/tasks/own/environment ${path.join("evals", "a", "tasks", "own", "environment")}`,
      `build app-evals ${path.join("evals", "image")}`,
      `build other ${path.join("evals", "b", "other")}`,
      "pull python:3.12-slim",
    ]);
    expect(pushed).toEqual({
      a: {
        images: {
          "app-evals": "sha256:app-evals",
          "python:3.12-slim": "sha256:python:3.12-slim",
        },
        dockerfiles: {
          "tasks/own/environment": "sha256:a/tasks/own/environment",
        },
      },
      b: {
        images: {
          "app-evals": "sha256:app-evals",
          other: "sha256:other",
          "python:3.12-slim": "sha256:python:3.12-slim",
        },
        dockerfiles: {},
      },
    });
  });

  void it("follows linked task dirs and matches them by their target's name", async () => {
    await write("s/harbor.yaml", "");
    await write("shared/refund-case/task.toml", "");
    await mkdir(path.join(root, "s/tasks"), { recursive: true });
    await symlink(
      path.join(root, "shared/refund-case"),
      path.join(root, "s/tasks/linked"),
    );
    await symlink(
      path.join(root, "missing"),
      path.join(root, "s/tasks/dangling"),
    );
    const dataset = path.join(root, "s");
    const dirs = async (tasks?: string[]) =>
      (await findTaskTomls(dataset, { tasks })).map((f) =>
        path.basename(path.dirname(f)),
      );

    // Harbor names a linked dir after its target.
    expect(await dirs()).toEqual(["linked"]);
    expect(await dirs(["refund-case"])).toEqual(["linked"]);
    expect(await dirs(["linked"])).toEqual([]);
  });

  void it("lists only the tasks the run includes, as Harbor resolves them", async () => {
    await write("s/harbor.yaml", "");
    for (const task of ["a-1", "a-2", "b-1"]) {
      await write(`s/tasks/${task}/task.toml`, "");
    }
    await write("s/tasks/notes/README.md");
    await write("s/tasks/.lmnr-state.json", "{}");
    await write("s/unreferenced/task.toml", "");
    const dataset = path.join(root, "s");
    const rel = async (overrides: object) =>
      (await findTaskTomls(dataset, overrides)).map((f) =>
        path.relative(root, path.dirname(f)).split(path.sep).join("/"),
      );

    expect(await rel({})).toEqual([
      "s/tasks/a-1",
      "s/tasks/a-2",
      "s/tasks/b-1",
    ]);
    // --task becomes the dataset's task_names.
    expect(await rel({ tasks: ["a-*"] })).toEqual([
      "s/tasks/a-1",
      "s/tasks/a-2",
    ]);
    expect(await rel({ tasks: ["b-1", "nope"] })).toEqual(["s/tasks/b-1"]);
  });

  void it("builds and pushes only the images of the tasks --task selects", async () => {
    await write(
      "evals/s/lmnr.yaml",
      "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n" +
        "  other:\n    dockerfile: other/Dockerfile\n",
    );
    await write("evals/s/harbor.yaml", "");
    await write(
      "evals/s/tasks/app/task.toml",
      '[environment]\ndocker_image = "app-evals"\n',
    );
    await write(
      "evals/s/tasks/other/task.toml",
      '[environment]\ndocker_image = "other"\n',
    );
    await write("evals/s/tasks/own/task.toml", "");
    await write("evals/s/tasks/own/environment/Dockerfile", "FROM alpine");
    const evals = path.join(root, "evals");
    const built: string[] = [];
    const pusher = {
      build: async (def: ImageDef) => {
        built.push(def.name);
        return `sha256:${def.name}`;
      },
      pull: async (ref: string) => `sha256:${ref}`,
    };

    const pushed = await ensureRemoteImages(
      evals,
      ["s"],
      { tasks: ["app"] },
      pusher,
    );
    expect(built).toEqual(["app-evals"]);
    expect(pushed).toEqual({
      s: { images: { "app-evals": "sha256:app-evals" }, dockerfiles: {} },
    });

    const dataset = path.join(evals, "s");
    const local = await localImageDefs(dataset, { tasks: ["app"] });
    expect(local.map((def) => def.name)).toEqual(["app-evals"]);
    const all = await localImageDefs(dataset, {});
    expect(all.map((def) => def.name).sort()).toEqual(["app-evals", "other"]);
  });

  void it("keys per-task Dockerfiles with / on every OS", () => {
    expect(
      dockerfileKey(
        "C:\\evals\\s",
        "C:\\evals\\s\\tasks\\own\\environment",
        path.win32,
      ),
    ).toBe("tasks/own/environment");
    expect(
      dockerfileKey("/evals/s", "/evals/s/tasks/own/environment", path.posix),
    ).toBe("tasks/own/environment");
  });
});

void describe("harborArgs", () => {
  void it("runs the pinned Harbor with the Laminar plugin, grouped by dataset version", () => {
    expect(harborArgs("/tmp/job.json", "support v7")).toEqual([
      "--python",
      "3.13",
      "--from",
      `harbor==${HARBOR_VERSION}`,
      "--with",
      `lmnr==${LMNR_PYTHON_VERSION}`,
      "harbor",
      "run",
      "-c",
      "/tmp/job.json",
      "--yes",
      "--plugin",
      "laminar",
      "--pk",
      "group_name=support v7",
    ]);
    expect(harborArgs("/tmp/job.json", "s", "8001").slice(-2)).toEqual([
      "--pk",
      "grpc_port=8001",
    ]);
  });
});

void describe("parseEnvFlags", () => {
  void it("takes KEY=VALUE as-is and reads a bare KEY from the env", () => {
    expect(
      parseEnvFlags(["A=1", "B=x=y", "C=", "OPENAI_API_KEY"], {
        OPENAI_API_KEY: "sk",
      }),
    ).toEqual({ A: "1", B: "x=y", C: "", OPENAI_API_KEY: "sk" });
  });

  void it("errors on an unset bare KEY or an invalid key", () => {
    expect(() => parseEnvFlags(["MISSING"], {})).toThrow(/not set/);
    expect(() => parseEnvFlags(["MISSING"], {})).toThrow(InvalidArgumentError);
    expect(() => parseEnvFlags(["=1"], {})).toThrow(/Invalid --env/);
    expect(() => parseEnvFlags(["1A=1"], {})).toThrow(/Invalid --env/);
  });
});

void describe("laminarBaseUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  void it("lets an explicit port replace one already in the URL", () => {
    delete process.env.LMNR_HTTP_PORT;
    const baseUrl = "http://localhost:8000/";
    expect(laminarBaseUrl({ baseUrl })).toBe("http://localhost:8000");
    expect(laminarBaseUrl({ baseUrl, port: 9000 })).toBe(
      "http://localhost:9000",
    );
    process.env.LMNR_HTTP_PORT = "8000";
    expect(laminarBaseUrl({ baseUrl })).toBe("http://localhost:8000");
    expect(laminarBaseUrl({ baseUrl: "https://lmnr.example.com" })).toBe(
      "https://lmnr.example.com:8000",
    );
  });
});

void describe("parsePositiveInt", () => {
  void it("accepts positive integers only", () => {
    expect(parsePositiveInt("3")).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parsePositiveInt(bad)).toThrow(/positive integer/);
    }
  });
});

void describe("assertRemotePassed", () => {
  void it("maps how a remote run ended to the CLI's exit codes", () => {
    expect(() =>
      assertRemotePassed({ kind: "exited", exitCode: 0 }),
    ).not.toThrow();
    expect(() => assertRemotePassed({ kind: "unsupported" })).not.toThrow();
    expect(() => assertRemotePassed({ kind: "exited", exitCode: 18 })).toThrow(
      expect.objectContaining({ code: "harbor_failed", exitCode: 18 }),
    );
    expect(() => assertRemotePassed({ kind: "exited", exitCode: 1 })).toThrow(
      expect.objectContaining({ code: "remote_run_failed", exitCode: 21 }),
    );
    expect(() =>
      assertRemotePassed({ kind: "lost", state: "error", reason: "OOM" }),
    ).toThrow(
      expect.objectContaining({
        code: "remote_run_failed",
        message: expect.stringMatching(/sandbox is error \(OOM\)/),
      }),
    );
  });
});
