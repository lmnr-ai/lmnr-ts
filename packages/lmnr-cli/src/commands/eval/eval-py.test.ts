import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildJobConfig,
  discoverDatasets,
  findTaskTomls,
  findTemplateVars,
  loadDatasetConfig,
} from "./datasets";
import {
  applyEvalRunner,
  type EvalDescription,
  LAMINAR_AGENT_IMPORT_PATH,
  LAMINAR_VERIFIER_IMPORT_PATH,
  parseDescription,
  parseScriptDependencies,
  setEvalDescription,
} from "./eval-py";
import { findTaskImages, loadImageDefs } from "./images";
import {
  ensureTaskFiles,
  INSTRUCTION_STUB,
  insertTomlKey,
  TEST_SH_STUB,
} from "./task-files";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ initializeLogger: () => logger }));

let root: string;

const write = async (rel: string, content = "") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const read = (rel: string) => readFile(path.join(root, rel), "utf8");

const description = (
  overrides: Partial<EvalDescription> = {},
): EvalDescription => ({
  version: 1,
  runner: "SupportEval",
  images: {
    "support-evals": {
      kind: "dockerfile",
      dockerfile: "/abs/support/agent/Dockerfile",
      context: "/abs",
    },
  },
  default_image: "support-evals",
  model: "anthropic/claude-sonnet-5-5",
  env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}", SUPPORT_TONE: "formal" },
  secrets: ["ANTHROPIC_API_KEY", "JUDGE_API_KEY"],
  new_task_toml: { agent: { timeout_sec: 300 } },
  grade_with_test_sh: false,
  warnings: [],
  ...overrides,
});

const RUNNER_KWARGS = { runner: "agent/eval.py:SupportEval" };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-eval-py-"));
  logger.info.mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("parseScriptDependencies", () => {
  void it("reads a PEP 723 script block", () => {
    const text = [
      "# /// script",
      '# dependencies = ["anthropic>=1", "httpx"]',
      "#",
      "# [tool.x]",
      "# ///",
      "from lmnr.evals import EvalRunner",
    ].join("\n");
    expect(parseScriptDependencies(text, "eval.py")).toEqual([
      "anthropic>=1",
      "httpx",
    ]);
    expect(parseScriptDependencies("import os\n", "eval.py")).toEqual([]);
  });

  void it("rejects broken blocks", () => {
    const block = '# /// script\n# dependencies = "anthropic"\n# ///\n';
    expect(() => parseScriptDependencies(block, "eval.py")).toThrow(
      expect.objectContaining({ code: "invalid_evals_dir" }),
    );
    expect(() =>
      parseScriptDependencies(
        "# /// script\n# ///\nimport os\n# /// script\n# ///\n",
        "eval.py",
      ),
    ).toThrow(/more than one/);
  });
});

void describe("parseDescription", () => {
  void it("accepts version 1 and rejects others", () => {
    const desc = description();
    expect(parseDescription(JSON.stringify(desc), "eval.py")).toEqual(desc);
    expect(() =>
      parseDescription(JSON.stringify({ ...desc, version: 2 }), "eval.py"),
    ).toThrow(/version 2.*reads version 1/);
    expect(() => parseDescription("Traceback ...", "eval.py")).toThrow(
      /printed no JSON/,
    );
  });
});

void describe("applyEvalRunner", () => {
  void it("generates the agent, the verifier and default datasets", () => {
    expect(applyEvalRunner({}, description(), "harbor.yaml")).toEqual({
      agents: [
        {
          import_path: LAMINAR_AGENT_IMPORT_PATH,
          kwargs: RUNNER_KWARGS,
          env: {
            ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
            SUPPORT_TONE: "formal",
          },
          model_name: "anthropic/claude-sonnet-5-5",
        },
      ],
      verifier: {
        import_path: LAMINAR_VERIFIER_IMPORT_PATH,
        kwargs: RUNNER_KWARGS,
      },
      datasets: [{ path: "tasks" }],
      images: {
        "support-evals": {
          dockerfile: "/abs/support/agent/Dockerfile",
          context: "/abs",
        },
      },
    });
  });

  void it("keeps harbor.yaml job settings and turns agents entries into a model sweep", () => {
    const job = applyEvalRunner(
      {
        n_concurrent_trials: 4,
        datasets: [{ path: "cases" }],
        verifier: { override_timeout_sec: 60 },
        agents: [
          { model_name: "openai/gpt-5" },
          { kwargs: { temperature: 0 } },
        ],
      },
      description({ model: null }),
      "harbor.yaml",
    );
    expect(job.n_concurrent_trials).toBe(4);
    expect(job.datasets).toEqual([{ path: "cases" }]);
    expect(job.verifier).toEqual({
      override_timeout_sec: 60,
      import_path: LAMINAR_VERIFIER_IMPORT_PATH,
      kwargs: RUNNER_KWARGS,
    });
    expect(job.agents).toEqual([
      expect.objectContaining({
        import_path: LAMINAR_AGENT_IMPORT_PATH,
        kwargs: RUNNER_KWARGS,
        model_name: "openai/gpt-5",
      }),
      expect.not.objectContaining({ model_name: expect.anything() }),
    ]);
    expect((job.agents as Record<string, unknown>[])[1].kwargs).toEqual({
      temperature: 0,
      ...RUNNER_KWARGS,
    });
  });

  void it("writes the runner's artifacts into the job config", () => {
    const artifacts = [
      "/srv/app/out/",
      { source: "/var/lib/app/state.db", destination: "app.db" },
    ];
    expect(
      applyEvalRunner({}, description({ artifacts }), "harbor.yaml").artifacts,
    ).toEqual(artifacts);
    expect(
      applyEvalRunner({}, description({ artifacts: [] }), "harbor.yaml"),
    ).not.toHaveProperty("artifacts");
  });

  void it("leaves the verifier to Harbor with verify = task", () => {
    const job = applyEvalRunner(
      { verifier: { import_path: "my.verifier:V" } },
      description({ grade_with_test_sh: true }),
      "harbor.yaml",
    );
    expect(job.verifier).toEqual({ import_path: "my.verifier:V" });
  });

  void it.each([
    [{ images: { x: { dockerfile: "D" } } }, /both define images/],
    [{ agents: [{ import_path: "agent.agent:A" }] }, /sets import_path/],
    [{ agents: [{ name: "claude-code" }] }, /sets name/],
    [{ agents: [{ env: { A: "1" } }] }, /both define the agent env/],
    [{ verifier: { import_path: "v:V" } }, /both define the verifier/],
    [{ artifacts: ["/srv/out"] }, /eval.py owns them/],
  ])(
    "rejects harbor.yaml defining what eval.py owns: %j",
    (config, message) => {
      expect(() =>
        applyEvalRunner(config, description(), "harbor.yaml"),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_evals_dir",
          message: expect.stringMatching(message),
        }),
      );
    },
  );

  void it("lets CLI flags win over both", () => {
    const job = buildJobConfig(
      applyEvalRunner({}, description(), "harbor.yaml"),
      { model: "openai/gpt-5", extraAgentEnv: ["EXTRA"], nConcurrent: 2 },
      false,
    );
    const [agent] = job.agents as Record<string, unknown>[];
    expect(agent.model_name).toBe("openai/gpt-5");
    expect(agent.env).toEqual({
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      SUPPORT_TONE: "formal",
      EXTRA: "${EXTRA}",
    });
    expect(job.n_concurrent_trials).toBe(2);
    expect(job.images).toBeUndefined(); // ours, not Harbor's
  });
});

void describe("eval.py datasets", () => {
  void it("are runnable without a harbor.yaml", async () => {
    await write("support/agent/eval.py");
    await write("support/tasks/refund/task.toml", 'docker_image = "x"');
    await write("legacy/harbor.yaml");
    await write("notes/README.md");
    expect(await discoverDatasets(root)).toEqual(["legacy", "support"]);

    const datasetDir = path.join(root, "support");
    await expect(loadDatasetConfig(datasetDir)).rejects.toThrow(
      /was not described/,
    );
    setEvalDescription(datasetDir, description());
    const config = await loadDatasetConfig(datasetDir);
    expect(config.datasets).toEqual([{ path: "tasks" }]);
    expect(await findTaskTomls(datasetDir, {})).toEqual([
      path.join(datasetDir, "tasks/refund/task.toml"),
    ]);
    expect(await loadImageDefs(datasetDir)).toEqual([
      {
        name: "support-evals",
        dockerfile: "/abs/support/agent/Dockerfile",
        context: "/abs",
      },
    ]);
  });

  void it("require their secrets and env vars like ${VAR}s", async () => {
    await write("support/agent/eval.py");
    await write("support/harbor.yaml", "n_concurrent_trials: ${N:-2}\n");
    await write(
      "support/tasks/refund/task.toml",
      '[verifier.env]\nX = "${TASK_VAR}"\n',
    );
    const datasetDir = path.join(root, "support");
    setEvalDescription(
      datasetDir,
      description({ env: { A: "${APP_KEY}", B: "${OPT:-x}" } }),
    );
    const vars = await findTemplateVars(datasetDir, {});
    expect([...vars.required].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "APP_KEY",
      "JUDGE_API_KEY",
      "TASK_VAR",
    ]);
    expect([...vars.optional].sort()).toEqual(["N", "OPT"]);
  });

  void it("start registry images like any docker_image", async () => {
    await write("support/agent/eval.py");
    const datasetDir = path.join(root, "support");
    const desc = description({
      images: { py: { kind: "registry", ref: "python:3.13-slim" } },
      default_image: "py",
    });
    setEvalDescription(datasetDir, desc);
    await write("support/tasks/refund/environment/case.json", "{}");
    await ensureTaskFiles(datasetDir, desc);
    expect(await loadImageDefs(datasetDir)).toEqual([]);
    expect((await findTaskImages(datasetDir, {})).images).toEqual([
      "python:3.13-slim",
    ]);
  });
});

void describe("task files", () => {
  const datasetDir = () => path.join(root, "support");

  void it("writes the missing files of a data-only task", async () => {
    await write(
      "support/tasks/dataset.toml",
      '[dataset]\nname = "acme/support"\n',
    );
    await write("support/tasks/refund/environment/ticket.json", "{}");
    await write("support/tasks/refund/tests/expected.json", "{}");
    await write("support/tasks/.lmnr-pull-tmp/x", "");

    const changes = await ensureTaskFiles(datasetDir(), description());
    expect(changes).toEqual([
      { file: "tasks/refund/task.toml", change: "created" },
      { file: "tasks/refund/instruction.md", change: "created" },
      { file: "tasks/refund/tests/test.sh", change: "created" },
    ]);
    expect(await read("support/tasks/refund/task.toml")).toBe(
      '[task]\nname = "acme/refund"\n\n[environment]\n' +
        'docker_image = "support-evals"\n\n[agent]\ntimeout_sec = 300\n',
    );
    expect(await read("support/tasks/refund/instruction.md")).toBe(
      INSTRUCTION_STUB,
    );
    expect(await read("support/tasks/refund/tests/test.sh")).toBe(TEST_SH_STUB);
    const mode = (
      await stat(path.join(root, "support/tasks/refund/tests/test.sh"))
    ).mode;
    expect(mode & 0o777).toBe(0o755);
    expect(logger.info).toHaveBeenCalledWith(
      "created support/tasks/refund/task.toml",
    );
    // Idempotent.
    expect(await ensureTaskFiles(datasetDir(), description())).toEqual([]);
  });

  void it("writes no test.sh stub with grade_with_test_sh", async () => {
    await write("support/tasks/refund/environment/case.json", "{}");
    const changes = await ensureTaskFiles(
      datasetDir(),
      description({ grade_with_test_sh: true }),
    );
    expect(changes.map((c) => c.file)).toEqual([
      "tasks/refund/task.toml",
      "tasks/refund/instruction.md",
    ]);
    await expect(
      stat(path.join(root, "support/tasks/refund/tests/test.sh")),
    ).rejects.toThrow();
  });

  void it("merges the template into a new task.toml", async () => {
    await write("support/tasks/own/environment/case.json", "{}");
    await ensureTaskFiles(
      datasetDir(),
      description({
        new_task_toml: {
          environment: { cpus: 2 },
          verifier: { env: { K: "${K}" } },
        },
      }),
    );
    // No dataset.toml: the org is the folder name.
    expect(await read("support/tasks/own/task.toml")).toBe(
      '[task]\nname = "support/own"\n\n[environment]\n' +
        'docker_image = "support-evals"\ncpus = 2\n\n' +
        '[verifier.env]\nK = "${K}"\n',
    );
  });

  void it("rejects a task Dockerfile before writing anything", async () => {
    await write("support/tasks/a-new/environment/case.json", "{}");
    await write("support/tasks/own/environment/Dockerfile", "FROM x");
    await expect(ensureTaskFiles(datasetDir(), description())).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_evals_dir",
        message: expect.stringMatching(
          /tasks\/own\/environment\/Dockerfile: a task can't bring its own image\. .*\(support-evals\).*docker_image = "<name>"/,
        ),
      }),
    );
    // Checked before the other task got its files.
    await expect(
      stat(path.join(root, "support/tasks/a-new/task.toml")),
    ).rejects.toThrow();
  });

  void it("only allows docker_images the runner declares", async () => {
    const images: EvalDescription["images"] = {
      "support-evals": {
        kind: "dockerfile",
        dockerfile: "/abs/Dockerfile",
        context: "/abs",
      },
      slim: { kind: "registry", ref: "python:3.13-slim" },
    };
    await write(
      "support/tasks/ocr/task.toml",
      '[task]\nname = "a/ocr"\n[environment]\ndocker_image = "python:3.13-slim"\n',
    );
    await ensureTaskFiles(datasetDir(), description({ images }));
    await write(
      "support/tasks/ocr/task.toml",
      '[task]\nname = "a/ocr"\n[environment]\ndocker_image = "ubuntu:24.04"\n',
    );
    await expect(
      ensureTaskFiles(datasetDir(), description({ images })),
    ).rejects.toThrow(
      "tasks/ocr/task.toml: docker_image = \"ubuntu:24.04\" isn't one of the runner's images",
    );
  });

  void it("completes an existing task.toml as text, keeping comments", async () => {
    const original =
      'version = "1.0"  # root key\n\n# Timeouts\n[agent]\ntimeout_sec = 60\n';
    await write("support/tasks/refund/task.toml", original);
    await write("support/tasks/refund/instruction.md", "Refund it.");
    const changes = await ensureTaskFiles(datasetDir(), description());
    expect(changes).toEqual([
      {
        file: "tasks/refund/task.toml",
        change: "completed",
        added: ["[task] name", "[environment] docker_image"],
      },
      { file: "tasks/refund/tests/test.sh", change: "created" },
    ]);
    expect(await read("support/tasks/refund/task.toml")).toBe(
      'version = "1.0"  # root key\n\n' +
        '[task]\nname = "support/refund"\n\n' +
        '[environment]\ndocker_image = "support-evals"\n\n' +
        "# Timeouts\n[agent]\ntimeout_sec = 60\n",
    );
    expect(await read("support/tasks/refund/instruction.md")).toBe(
      "Refund it.",
    );
  });

  void it("lists changes without writing on a dry run", async () => {
    await write("support/tasks/refund/environment/x.json", "{}");
    const changes = await ensureTaskFiles(datasetDir(), description(), true);
    expect(changes.map((c) => c.file)).toEqual([
      "tasks/refund/task.toml",
      "tasks/refund/instruction.md",
      "tests/test.sh".replace(/^/, "tasks/refund/"),
    ]);
    await expect(
      stat(path.join(root, "support/tasks/refund/task.toml")),
    ).rejects.toThrow();
    expect(logger.info).toHaveBeenCalledWith(
      "would create support/tasks/refund/task.toml",
    );
  });

  void it("refuses to name a task after an invalid dir name", async () => {
    await write("support/tasks/my case/environment/x.json", "{}");
    await expect(ensureTaskFiles(datasetDir(), description())).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_evals_dir",
        message: expect.stringMatching(/my case is no valid name part/),
      }),
    );
  });
});

void describe("insertTomlKey", () => {
  void it("adds to an existing table right after its header", () => {
    expect(
      insertTomlKey(
        '[task]  # the task\ndescription = "d"\n',
        "task",
        'name = "a/b"',
      ),
    ).toBe('[task]  # the task\nname = "a/b"\ndescription = "d"\n');
    expect(insertTomlKey("[environment]", "environment", "x = 1")).toBe(
      "[environment]\nx = 1\n",
    );
  });

  void it("adds a table after the root keys", () => {
    expect(insertTomlKey('version = "1"', "task", 'name = "a/b"')).toBe(
      'version = "1"\n\n[task]\nname = "a/b"\n',
    );
    expect(insertTomlKey("", "task", 'name = "a/b"')).toBe(
      '[task]\nname = "a/b"\n',
    );
    expect(insertTomlKey("[task.extra]\nx = 1\n", "task", 'name = "a/b"')).toBe(
      '[task]\nname = "a/b"\n\n[task.extra]\nx = 1\n',
    );
  });
});
