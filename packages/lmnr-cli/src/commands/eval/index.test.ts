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

import { dirDigest, treeDigest } from "./digest";
import { guardedDockerfile } from "./docker";
import { laminarBaseUrl, parseEnvFlags, resolveTemplateEnv } from "./env";
import { HARBOR_VERSION, harborArgs, LMNR_PYTHON_VERSION } from "./harbor";
import {
  ensureRemoteImages,
  findTaskImages,
  type ImageDef,
  localImageDefs,
} from "./images";
import { assertRemotePassed, parsePositiveInt } from "./index";
import {
  assertNoTaskBuilds,
  buildJobConfig,
  discoverAgents,
  findTaskDirs,
  findTemplateVars,
  globToRegExp,
  LAMINAR_ENVIRONMENT_IMPORT_PATH,
  loadAgentConfig,
  localTaskSets,
  readState,
  readTaskToml,
  writeState,
} from "./layout";
import { applyMerge, planMerge } from "./merge";
import { excludeTop, packFiles, walkFiles } from "./pack";
import { parseTaskSetSelector } from "./prepare";
import { AGENT_SCRIPTS } from "./store";
import { parseTarget } from "./sync";

let root: string;

const write = async (rel: string, content = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const pack = async (
  dir: string,
  platform: NodeJS.Platform = process.platform,
) => {
  const { files, skippedSymlinks } = await walkFiles(dir, platform);
  return {
    ...(await packFiles(files)),
    fileCount: files.length,
    skippedSymlinks,
  };
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

void describe("layout", () => {
  void it("finds agent dirs and their task sets", async () => {
    await write("support/agent.yaml", "job: {}");
    await write("support/task_sets/checkout/a/task.toml");
    await write("support/task_sets/billing/b/task.toml");
    await write("support/task_sets/notes.md");
    await write("not-an-agent/README.md");
    await write("node_modules/x/agent.yaml");

    expect(await discoverAgents(root)).toEqual(["support"]);
    expect(await localTaskSets(path.join(root, "support"))).toEqual([
      "billing",
      "checkout",
    ]);
    expect(await discoverAgents(path.join(root, "missing"))).toEqual([]);
  });

  void it("reads agent.yaml images relative to the agent dir", async () => {
    await write(
      "evals/support/agent.yaml",
      "images:\n  app:\n    dockerfile: environment/Dockerfile\n    context: ../..\n" +
        "  plain:\n    dockerfile: plain/Dockerfile\n" +
        "job:\n  n_attempts: 2\n",
    );
    const agentDir = path.join(root, "evals/support");
    expect(await loadAgentConfig(agentDir)).toEqual({
      images: [
        {
          name: "app",
          dockerfile: path.join(agentDir, "environment/Dockerfile"),
          context: root,
        },
        {
          name: "plain",
          dockerfile: path.join(agentDir, "plain/Dockerfile"),
          context: path.join(agentDir, "plain"),
        },
      ],
      job: { n_attempts: 2 },
    });
    await write("bad/agent.yaml", "images:\n  x: {}\n");
    await expect(loadAgentConfig(path.join(root, "bad"))).rejects.toMatchObject(
      { code: "invalid_evals_dir", exitCode: 16 },
    );
  });

  void it("finds task dirs, narrowed by --task globs", async () => {
    for (const task of ["a-1", "a-2", "b-1"]) {
      await write(`set/${task}/task.toml`);
    }
    await write("set/notes/README.md");
    const names = async (tasks?: string[]) =>
      (await findTaskDirs(path.join(root, "set"), tasks)).map((d) =>
        path.basename(d),
      );
    expect(await names()).toEqual(["a-1", "a-2", "b-1"]);
    expect(await names(["a-*"])).toEqual(["a-1", "a-2"]);
  });

  void it("rejects tasks that build their own environment", async () => {
    await write("set/ok/task.toml", '[environment]\ndocker_image = "app"\n');
    await write("set/ok/environment/seed.json", "{}");
    await assertNoTaskBuilds(path.join(root, "set"));

    await write("set/own/task.toml");
    await write("set/own/environment/Dockerfile", "FROM alpine");
    await expect(
      assertNoTaskBuilds(path.join(root, "set")),
    ).rejects.toMatchObject({
      code: "invalid_evals_dir",
      message: expect.stringMatching(/own\/environment\/Dockerfile/),
    });
  });

  void it("reads a task's docker_image and [metadata]", async () => {
    await write(
      "t/task.toml",
      '[environment]\ndocker_image = "app"\n[metadata]\ncluster_id = "c1"\ntrace_ids = ["t1"]\n',
    );
    expect(await readTaskToml(path.join(root, "t"))).toEqual({
      dockerImage: "app",
      metadata: { cluster_id: "c1", trace_ids: ["t1"] },
    });
  });

  void it("round-trips a task set copy's state", async () => {
    const dir = path.join(root, "set");
    await mkdir(dir);
    expect(await readState(dir)).toBeNull();
    const state = { versionId: "v1", number: 1, hash: "h", tasks: { a: "d" } };
    await writeState(dir, state);
    expect(await readState(dir)).toEqual(state);
  });
});

void describe("walkFiles / packFiles", () => {
  void it("packs a dir's contents at the archive root, minus exclusions", async () => {
    await write("agent.yaml", "job: {}");
    await write("adapter.py");
    await write("task_sets/s/t/task.toml");
    await write(".lmnr.json", "{}");
    await write(".env", "SECRET=1");
    await write("environment/.env.local", "SECRET=1");
    await write(".git/config");
    await write("node_modules/pkg/index.js");
    await write(".venv/bin/python");
    await write("t/__pycache__/x.pyc");
    await write("jobs/2026-10-28__12-00-00/result.json");

    const { files } = await walkFiles(root, process.platform, AGENT_SCRIPTS);
    const { archive } = await packFiles(files);
    const names = (await filesOf(archive)).map((e) => e.header.name).sort();
    expect(names).toEqual(["adapter.py", "agent.yaml"]);

    const all = await walkFiles(
      root,
      process.platform,
      excludeTop(".lmnr.json"),
    );
    expect(all.files.map((f) => f.target)).toContain("task_sets/s/t/task.toml");
  });

  void it("keeps the executable bit and skips symlinks", async () => {
    await write("t/tests/test.sh", "#!/bin/sh");
    await chmod(path.join(root, "t/tests/test.sh"), 0o755);
    await symlink("/etc/passwd", path.join(root, "passwd"));

    const { archive, skippedSymlinks } = await pack(root);

    expect(skippedSymlinks).toEqual(["passwd"]);
    const script = (await filesOf(archive)).find(
      (e) => e.header.name === "t/tests/test.sh",
    );
    expect(script!.header.mode! & 0o111).toBe(0o111);
  });

  void it("indexes every file so it can be read from its gzip member alone", async () => {
    const big = Buffer.alloc(1536 * 1024, "b");
    const longName = `${"deep/".repeat(30)}file.txt`;
    await write("agent.yaml", "job: {}");
    await write("a/task.toml", "[task]");
    await write("a/data.bin", big.toString());
    await write("a/after-big.txt", "after");
    await write("a/empty.txt", "");
    await write(longName, "long");

    const { archive, index } = await pack(root);

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
    expect(offsets["a/data.bin"]).toBe(offsets["a/after-big.txt"]);
    expect(offsets["a/empty.txt"]).not.toBe(offsets["a/data.bin"]);
    expect(offsets["agent.yaml"]).not.toBe(offsets["a/data.bin"]);
  });

  void it("marks shell scripts executable when packed on Windows", async () => {
    await write("agent.yaml");
    await write("t/tests/test.sh", "#!/bin/sh");
    await chmod(path.join(root, "t/tests/test.sh"), 0o644);

    const { archive } = await pack(root, "win32");

    const modes = Object.fromEntries(
      (await filesOf(archive)).map((e) => [
        e.header.name,
        e.header.mode! & 0o777,
      ]),
    );
    expect(modes["t/tests/test.sh"]).toBe(0o755);
    expect(modes["agent.yaml"]).toBe(0o644);
  });
});

void describe("treeDigest", () => {
  void it("hashes paths and contents, not modes or walk order", async () => {
    await write("a/task.toml", "x");
    await write("a-b/task.toml", "y");
    const first = await dirDigest(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await chmod(path.join(root, "a/task.toml"), 0o755);
    expect(await dirDigest(root)).toBe(first);
    const { files } = await walkFiles(root);
    expect(await treeDigest([...files].reverse())).toBe(first);

    await write("a/task.toml", "changed");
    expect(await dirDigest(root)).not.toBe(first);
  });

  void it("leaves excluded entries out", async () => {
    await write("agent.yaml");
    const scripts = await dirDigest(root, AGENT_SCRIPTS);
    await write("task_sets/s/t/task.toml");
    await write(".lmnr.json", "{}");
    expect(await dirDigest(root, AGENT_SCRIPTS)).toBe(scripts);
  });
});

void describe("buildJobConfig", () => {
  const base = {
    environment: { type: "docker", kwargs: { x: 1 }, env: { A: "1" } },
    agents: [{ import_path: "agent.agent:MyAgent", env: { K: "${K}" } }],
    datasets: [{ path: "ignored" }],
    tasks: [{ path: "extra/alpha" }],
  };

  void it("makes the task set its only dataset", () => {
    const job = buildJobConfig(base, "/evals/a/task_sets/s", {}, false);
    expect(job.datasets).toEqual([{ path: "/evals/a/task_sets/s" }]);
    expect(job.tasks).toBeUndefined();
    expect(job.environment).toEqual(base.environment);
  });

  void it("routes remote trials to the Laminar environment", () => {
    const job = buildJobConfig(base, "/s", {}, true);
    expect(job.environment).toEqual({
      env: { A: "1" },
      import_path: LAMINAR_ENVIRONMENT_IMPORT_PATH,
    });
    expect(base.environment.type).toBe("docker");
  });

  void it("applies attempts, concurrency, task filters, model and --env", () => {
    const job = buildJobConfig(
      base,
      "/s",
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
    expect(job.datasets).toEqual([{ path: "/s", task_names: ["al*"] }]);
    expect(job.agents).toEqual([
      {
        import_path: "agent.agent:MyAgent",
        model_name: "anthropic/claude-sonnet-5-5",
        env: { K: "${K}", EXTRA: "${EXTRA}" },
      },
    ]);
  });

  void it("materializes Harbor's default agent to apply a model", () => {
    expect(buildJobConfig({}, "/s", { model: "m" }, false).agents).toEqual([
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
  void it("finds ${VAR} placeholders in agent.yaml and the run's task.toml files", async () => {
    await write(
      "a/agent.yaml",
      "job:\n  agents:\n    - env:\n        OPENAI_API_KEY: ${OPENAI_API_KEY}\n        M: ${MODEL:-gpt}\n",
    );
    await write(
      "a/task_sets/s/t/task.toml",
      '[verifier.env]\nJUDGE_KEY = "${JUDGE_KEY}"\n',
    );
    await write("a/task_sets/s/other/task.toml", '[x]\nY = "${OTHER_KEY}"\n');
    const agentDir = path.join(root, "a");
    const setDir = path.join(agentDir, "task_sets/s");

    const vars = await findTemplateVars(agentDir, [setDir], {});
    expect([...vars.required].sort()).toEqual([
      "JUDGE_KEY",
      "OPENAI_API_KEY",
      "OTHER_KEY",
    ]);
    expect([...vars.optional]).toEqual(["MODEL"]);

    // A task --task leaves out doesn't need its variables.
    const only = await findTemplateVars(agentDir, [setDir], { tasks: ["t"] });
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

  void it("builds referenced agent.yaml images, pulls the rest, each once", async () => {
    for (const set of ["s1", "s2"]) {
      await write(
        `${set}/shared/task.toml`,
        '[environment]\ndocker_image = "app"\n',
      );
      await write(
        `${set}/public/task.toml`,
        "[environment]\ndocker_image = 'python:3.12-slim'\n",
      );
    }
    await write("s1/data-only/task.toml", "");
    const defs: ImageDef[] = [
      { name: "app", dockerfile: "/a/Dockerfile", context: "/a" },
      { name: "unused", dockerfile: "/u/Dockerfile", context: "/u" },
    ];
    const calls: string[] = [];
    const pusher = {
      build: async (def: ImageDef) => {
        calls.push(`build ${def.name}`);
        return `sha256:${def.name}`;
      },
      pull: async (ref: string) => {
        calls.push(`pull ${ref}`);
        return `sha256:${ref}`;
      },
    };
    const sets = [path.join(root, "s1"), path.join(root, "s2")];

    expect((await findTaskImages(sets, {})).sort()).toEqual([
      "app",
      "python:3.12-slim",
    ]);
    const pushed = await ensureRemoteImages(defs, sets, {}, pusher);
    // `unused` is in agent.yaml but no task references it: never built.
    expect(calls.sort()).toEqual(["build app", "pull python:3.12-slim"]);
    expect(pushed).toEqual({
      images: {
        app: "sha256:app",
        "python:3.12-slim": "sha256:python:3.12-slim",
      },
    });

    // --task narrows the images too.
    const local = await localImageDefs(defs, sets, { tasks: ["data-only"] });
    expect(local).toEqual([]);
    expect((await localImageDefs(defs, sets, {})).map((d) => d.name)).toEqual([
      "app",
    ]);
  });
});

void describe("planMerge / applyMerge", () => {
  void it("takes each side's changes and flags tasks both sides changed", () => {
    const base = {
      same: "1",
      local: "1",
      remote: "1",
      both: "1",
      gone: "1",
      kept: "1",
    };
    const local = {
      same: "1",
      local: "2",
      remote: "1",
      both: "2",
      gone: "1",
      added: "9",
      kept: "3",
    };
    const remote = {
      same: "1",
      local: "1",
      remote: "2",
      both: "3",
      new: "5",
      added: "9",
    };
    expect(planMerge(base, local, remote)).toEqual({
      take: ["new", "remote"],
      remove: ["gone"],
      // `kept` was deleted remotely but changed locally.
      conflicts: ["both", "kept"],
    });
    // A fresh copy takes everything.
    expect(planMerge({}, {}, { a: "1", b: "2" })).toEqual({
      take: ["a", "b"],
      remove: [],
      conflicts: [],
    });
  });

  void it("copies remote tasks and top-level files over the local copy", async () => {
    await write("local/mine/task.toml", "mine");
    await write("local/stale/task.toml", "old");
    await write("local/gone/task.toml", "x");
    await write("remote/stale/task.toml", "new");
    await write("remote/fresh/task.toml", "fresh");
    await write("remote/README.md", "readme");
    await write("remote/.lmnr.json", "{}");
    const localDir = path.join(root, "local");

    await applyMerge(
      localDir,
      path.join(root, "remote"),
      { take: ["fresh", "stale"], remove: ["gone"], conflicts: [] },
      { stale: "s", fresh: "f" },
    );

    const read = (rel: string) => readFile(path.join(localDir, rel), "utf8");
    expect(await read("mine/task.toml")).toBe("mine");
    expect(await read("stale/task.toml")).toBe("new");
    expect(await read("fresh/task.toml")).toBe("fresh");
    expect(await read("README.md")).toBe("readme");
    expect(await findTaskDirs(localDir)).not.toContain(
      path.join(localDir, "gone"),
    );
    await expect(read(".lmnr.json")).rejects.toThrow();
  });
});

void describe("targets", () => {
  void it("parses <agent>[/<task set>][@<version>]", () => {
    expect(parseTarget("support")).toEqual({ agent: "support" });
    expect(parseTarget("support/checkout@3")).toEqual({
      agent: "support",
      taskSet: "checkout",
      number: 3,
    });
    expect(() => parseTarget("support@3")).toThrow(/Only a task set/);
    expect(() => parseTarget("a/b/c")).toThrow(/Invalid target/);
    expect(() => parseTarget("../x")).toThrow();
  });

  void it("parses --task-set name[@version]", () => {
    expect(parseTaskSetSelector("checkout")).toEqual({ name: "checkout" });
    expect(parseTaskSetSelector("checkout@12")).toEqual({
      name: "checkout",
      number: 12,
    });
    expect(() => parseTaskSetSelector("bad name")).toThrow(/Invalid task set/);
  });
});

void describe("harborArgs", () => {
  void it("runs the pinned Harbor with the Laminar plugin, grouped by task set", () => {
    expect(harborArgs("/tmp/job.json", "support/checkout")).toEqual([
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
      "group_name=support/checkout",
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
