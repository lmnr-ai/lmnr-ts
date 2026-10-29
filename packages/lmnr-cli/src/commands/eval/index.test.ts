import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { unpackTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { harborArgs } from "./harbor";
import {
  dockerfileKey,
  findTaskDockerfiles,
  loadImageDefs,
  packBuildContext,
  stageBuildContext,
} from "./images";
import {
  laminarBaseUrl,
  parseEnvFlags,
  parsePositiveInt,
  resolveTemplateEnv,
} from "./index";
import { discoverSuites, packEvalsDir } from "./pack";
import {
  buildJobConfig,
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

const filesOf = async (archive: Buffer, gzip = true) =>
  (await unpackTar(gzip ? gunzipSync(archive) : archive)).filter(
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
    const job = buildJobConfig(base, { remote: true });
    expect(job.environment).toEqual({
      env: { A: "1" },
      import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH,
    });
    expect(base.environment.type).toBe("docker");
  });

  void it("leaves local runs on the suite's environment", () => {
    expect(buildJobConfig(base, { remote: false }).environment).toEqual(
      base.environment,
    );
  });

  void it("applies attempts, concurrency, task filters, model and --env", () => {
    const job = buildJobConfig(base, {
      remote: false,
      nAttempts: 3,
      nConcurrent: 8,
      tasks: ["al*"],
      model: "anthropic/claude-sonnet-5-5",
      extraAgentEnv: ["K", "EXTRA"],
    });
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
    expect(buildJobConfig({}, { remote: false, model: "m" }).agents).toEqual([
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

    const vars = await findTemplateVars(path.join(root, "s"));
    expect([...vars.required].sort()).toEqual(["JUDGE_KEY", "OPENAI_API_KEY"]);
    expect([...vars.optional]).toEqual(["MODEL"]);
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

  void it("packs a deterministic build context that honors .dockerignore", async () => {
    await write("ctx/Dockerfile", "FROM python:3.12-slim\nCOPY app /app\n");
    await write("ctx/app/main.py", "print(1)");
    await write("ctx/data/big.bin", "ignored");
    await write("ctx/.git/HEAD", "ignored");
    await write("ctx/.env", "SECRET=1");
    await write("ctx/app/.env.local", "SECRET=1");
    await write("ctx/.dockerignore", "data/\n");
    const dockerfile = path.join(root, "ctx/Dockerfile");

    const first = await packBuildContext(dockerfile, path.join(root, "ctx"));
    await utimes(path.join(root, "ctx/app/main.py"), new Date(), new Date());
    const second = await packBuildContext(dockerfile, path.join(root, "ctx"));

    expect(first.dockerfile).toContain("COPY app /app");
    expect(second.hash).toBe(first.hash);
    const names = (await filesOf(first.tar, false))
      .map((e) => e.header.name)
      .sort();
    expect(names).toEqual([".dockerignore", "Dockerfile", "app/main.py"]);
  });

  void it("reads include as normalized paths inside the context", async () => {
    await write(
      "evals/lmnr.yaml",
      "images:\n  app:\n    dockerfile: image/Dockerfile\n    context: ..\n    include: [agent/, ./shared/lib, 'tools\\\\cli']\n",
    );
    const [def] = await loadImageDefs(path.join(root, "evals"));
    expect(def?.include).toEqual(["agent", "shared/lib", "tools/cli"]);

    for (const bad of ["[]", "[../outside]", "[/abs]", "[.]", "[1]", "agent"]) {
      await write(
        "evals/lmnr.yaml",
        `images:\n  app:\n    dockerfile: image/Dockerfile\n    include: ${bad}\n`,
      );
      await expect(loadImageDefs(path.join(root, "evals"))).rejects.toThrow(
        /images\.app\.include/,
      );
    }
  });

  void it("stages only included paths, still honoring .dockerignore", async () => {
    await write("repo/agent/main.py", "print(1)");
    await write("repo/agent/.env", "SECRET=1");
    await write("repo/shared/util.py", "x = 1");
    await write("repo/shared/cache/blob.bin", "ignored");
    await write("repo/other/huge.bin", "not included");
    await write("repo/README.md", "not included");
    await write("repo/.dockerignore", "shared/cache/\n");
    await write("repo/evals/image/Dockerfile", "FROM python:3.12-slim\n");
    const def = {
      name: "app",
      dockerfile: path.join(root, "repo/evals/image/Dockerfile"),
      context: path.join(root, "repo"),
    };

    const staged = await stageBuildContext({
      ...def,
      include: ["shared", "agent", "agent/main.py"],
    });
    try {
      const files = (
        await readdir(staged, { recursive: true, withFileTypes: true })
      )
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(staged, path.join(entry.parentPath, entry.name)),
        )
        .sort();
      expect(files).toEqual([
        path.join("agent", "main.py"),
        path.join("shared", "util.py"),
      ]);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }

    await expect(
      stageBuildContext({ ...def, include: ["agent", "missing"] }),
    ).rejects.toThrow(/Included path not found/);
  });

  void it("stages included files for a local docker build", async () => {
    await write("repo/agent/run.sh", "#!/bin/sh\necho hi\n");
    await chmod(path.join(root, "repo/agent/run.sh"), 0o755);
    await write("repo/other/huge.bin", "not included");
    await write("repo/Dockerfile", "FROM alpine\n");
    const staged = await stageBuildContext({
      name: "app",
      dockerfile: path.join(root, "repo/Dockerfile"),
      context: path.join(root, "repo"),
      include: ["agent"],
    });
    try {
      expect((await readdir(staged, { recursive: true })).sort()).toEqual([
        "agent",
        path.join("agent", "run.sh"),
      ]);
      const mode = (await stat(path.join(staged, "agent/run.sh"))).mode;
      expect(mode & 0o111).not.toBe(0);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  void it("finds per-task Dockerfiles only where no docker_image is set", async () => {
    await write("s/tasks/own/task.toml", "[environment]\ncpus = 1\n");
    await write("s/tasks/own/environment/Dockerfile", "FROM alpine");
    await write(
      "s/tasks/shared/task.toml",
      '[environment]\ndocker_image = "app-evals"\n',
    );
    await write("s/tasks/shared/environment/Dockerfile", "FROM alpine");
    await write("s/tasks/data-only/task.toml", "");

    expect(await findTaskDockerfiles(path.join(root, "s"))).toEqual([
      path.join(root, "s/tasks/own/environment"),
    ]);
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
      "harbor==0.25.0",
      "--with",
      "lmnr==0.8.3",
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
