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
import { parsePositiveInt } from "./index";
import { packEvalsDir } from "./pack";
import {
  buildJobConfig,
  discoverSuites,
  findTaskTomls,
  findTemplateVars,
  globToRegExp,
  LAMINAR_ENVIRONMENT_IMPORT_PATH,
} from "./suites";

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

void describe("discoverSuites / packEvalsDir", () => {
  void it("finds suites and packs the folder's contents at the archive root", async () => {
    await write("hello/harbor.yaml", "agents: []");
    await write("hello/tasks/hello-world/task.toml");
    await write("other/harbor.yaml");
    await write("lmnr.yaml");

    expect(await discoverSuites(root)).toEqual(["hello", "other"]);
    const { archive, fileCount } = await packEvalsDir(root);
    expect(fileCount).toBe(4);
    const names = (await filesOf(archive)).map((e) => e.header.name).sort();
    expect(names).toEqual([
      "hello/harbor.yaml",
      "hello/tasks/hello-world/task.toml",
      "lmnr.yaml",
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

  void it("rejects a folder without suites at its root", async () => {
    await write("evals/hello/harbor.yaml");
    await expect(discoverSuites(root)).rejects.toMatchObject({
      code: "invalid_evals_dir",
      exitCode: 16,
    });
    await expect(
      discoverSuites(path.join(root, "missing")),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });
});

void describe("buildJobConfig", () => {
  const base = {
    environment: { type: "docker", kwargs: { x: 1 }, env: { A: "1" } },
    agents: [{ import_path: "agent.agent:MyAgent", env: { K: "${K}" } }],
    datasets: [{ path: "tasks" }],
    tasks: [{ path: "extra/alpha" }, { path: "extra/beta" }],
  };

  void it("routes remote trials to the Laminar environment", () => {
    const job = buildJobConfig(base, {}, true);
    expect(job.environment).toEqual({
      env: { A: "1" },
      import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH,
    });
    expect(base.environment.type).toBe("docker");
  });

  void it("leaves local runs on the suite's environment", () => {
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
    expect(job.tasks).toEqual([{ path: "extra/alpha" }]);
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
      "agents:\n  - env:\n      OPENAI_API_KEY: ${OPENAI_API_KEY}\n      M: ${MODEL:-gpt}\n" +
        "datasets:\n  - path: tasks\n",
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
  void it("reads lmnr.yaml images relative to the evals folder", async () => {
    await write(
      "evals/lmnr.yaml",
      "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n    context: ..\n  plain:\n    dockerfile: plain/Dockerfile\n",
    );
    const defs = await loadImageDefs(path.join(root, "evals"));
    expect(defs).toEqual([
      {
        name: "app-evals",
        dockerfile: path.join(root, "evals/image/Dockerfile"),
        context: root,
      },
      {
        name: "plain",
        dockerfile: path.join(root, "evals/plain/Dockerfile"),
        context: path.join(root, "evals/plain"),
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
    await write("s/harbor.yaml", "datasets:\n  - path: tasks\n");
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
    await write(
      "s/harbor.yaml",
      "environment:\n  force_build: true\ndatasets:\n  - path: tasks\n",
    );
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
    await write(
      "evals/lmnr.yaml",
      "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n" +
        "  unused:\n    dockerfile: unused/Dockerfile\n",
    );
    for (const suite of ["a", "b"]) {
      await write(`evals/${suite}/harbor.yaml`, "datasets:\n  - path: tasks\n");
      await write(
        `evals/${suite}/tasks/shared/task.toml`,
        '[environment]\ndocker_image = "app-evals"\n',
      );
      await write(
        `evals/${suite}/tasks/public/task.toml`,
        '[environment]\ndocker_image = "python:3.12-slim"\n',
      );
    }
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
      "pull python:3.12-slim",
    ]);
    expect(pushed).toEqual({
      images: {
        "app-evals": "sha256:app-evals",
        "python:3.12-slim": "sha256:python:3.12-slim",
      },
      dockerfiles: {
        a: { "tasks/own/environment": "sha256:a/tasks/own/environment" },
        b: {},
      },
    });
  });

  void it("lists only the tasks the run includes, as Harbor resolves them", async () => {
    await write(
      "s/harbor.yaml",
      [
        "datasets:",
        "  - path: tasks",
        "    exclude_task_names: [skip-*]",
        "  - name: terminal-bench",
        "tasks:",
        "  - path: ../shared/extra",
        "  - name: org/registry-task",
        "",
      ].join("\n"),
    );
    for (const task of ["a-1", "a-2", "b-1", "skip-me"]) {
      await write(`s/tasks/${task}/task.toml`, "");
    }
    await write("s/tasks/notes/README.md");
    await write("s/unreferenced/task.toml", "");
    await write("shared/extra/task.toml", "");
    const suite = path.join(root, "s");
    const rel = async (overrides: object) =>
      (await findTaskTomls(suite, overrides)).map((f) =>
        path.relative(root, path.dirname(f)).split(path.sep).join("/"),
      );

    expect(await rel({})).toEqual([
      "s/tasks/a-1",
      "s/tasks/a-2",
      "s/tasks/b-1",
      "shared/extra",
    ]);
    // --task replaces the datasets' task_names and filters `tasks` by name.
    expect(await rel({ tasks: ["a-*"] })).toEqual([
      "s/tasks/a-1",
      "s/tasks/a-2",
    ]);
    expect(await rel({ tasks: ["extra", "skip-me"] })).toEqual([
      "shared/extra",
    ]);
  });

  void it("builds and pushes only the images of the tasks --task selects", async () => {
    await write(
      "evals/lmnr.yaml",
      "images:\n  app-evals:\n    dockerfile: image/Dockerfile\n" +
        "  other:\n    dockerfile: other/Dockerfile\n",
    );
    await write("evals/s/harbor.yaml", "datasets:\n  - path: tasks\n");
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
      images: { "app-evals": "sha256:app-evals" },
      dockerfiles: { s: {} },
    });

    const local = await localImageDefs(evals, ["s"], { tasks: ["app"] });
    expect(local.map((def) => def.name)).toEqual(["app-evals"]);
    const all = await localImageDefs(evals, ["s"], {});
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
  void it("runs the pinned Harbor with the Laminar plugin, grouped by suite", () => {
    expect(harborArgs("/tmp/job.json", "support")).toEqual([
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
      "group_name=support",
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
