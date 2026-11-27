import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeArgs, describeEvalPy } from "./describe";
import { handleEvalDescribe } from "./describe-command";
import { withRysticToken } from "./env";
import {
  type EvalDescription,
  LAMINAR_AGENT_IMPORT_PATH,
  LAMINAR_VERIFIER_IMPORT_PATH,
} from "./eval-py";
import { LMNR_PYTHON_VERSION, pythonRequirements } from "./harbor";
import { handleEvalRun } from "./index";
import { captureCommand, runCommand } from "./run-command";
import { handleEvalTaskNew } from "./task-command";

vi.mock("./run-command", () => ({
  runCommand: vi.fn(),
  captureCommand: vi.fn(),
}));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({ initializeLogger: () => logger }));
/** The project key check of local runs (`checkProjectKey`, `fetch`). */
const keyCheck = vi.fn();

let root: string;
let cwd: string;

const write = async (rel: string, content = "") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

const EVAL_PY = `# /// script
# dependencies = ["anthropic>=1"]
# ///
from lmnr.evals import EvalRunner
`;

const DESCRIPTION: EvalDescription = {
  version: 1,
  runner: "SupportEval",
  images: {
    "support-evals": {
      kind: "generated",
      dockerfile_text: "FROM python:3.13-slim\n",
      context: "/abs",
      steps: [],
    },
  },
  default_image: "support-evals",
  model: "anthropic/claude-sonnet-5-5",
  env: { APP_KEY: "${APP_KEY}" },
  secrets: ["APP_KEY", "JUDGE_KEY"],
  new_task_toml: {},
  grade_with_test_sh: false,
  warnings: ["SupportEval defines run(), so `run_command` is ignored."],
  modules: ["support/agent/eval.py"],
  artifacts: [],
  services: [],
  classes: [{ name: "SupportEval", file: "support/agent/eval.py" }],
  mocks: [],
  mock_dependencies: [],
  laminar_layer: { python: "3.13", lmnr: "lmnr==0.9.3", build_contexts: {} },
};

const describeOk = (description: EvalDescription = DESCRIPTION) =>
  vi.mocked(captureCommand).mockResolvedValue({
    code: 0,
    stdout: JSON.stringify(description),
    stderr: "Installed 40 packages in 50ms\n",
  });

beforeEach(async () => {
  keyCheck.mockReset().mockResolvedValue(new Response("[]"));
  vi.stubGlobal("fetch", keyCheck);
  root = await mkdtemp(path.join(tmpdir(), "lmnr-describe-"));
  // Secrets and the project key come from the env or .env in the cwd.
  cwd = process.cwd();
  process.chdir(root);
  process.env.LMNR_PROJECT_API_KEY = "proj-key";
  process.env.APP_KEY = "app";
  process.env.JUDGE_KEY = "judge";
});

afterEach(async () => {
  process.chdir(cwd);
  vi.unstubAllGlobals();
  vi.mocked(runCommand).mockReset();
  vi.mocked(captureCommand).mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  for (const key of [
    "LMNR_PROJECT_API_KEY",
    "APP_KEY",
    "JUDGE_KEY",
    "LMNR_EVAL_LMNR_SPEC",
    "RYSTIC_TOKEN",
  ]) {
    delete process.env[key];
  }
  await rm(root, { recursive: true, force: true });
});

void describe("describeEvalPy", () => {
  void it("runs lmnr.evals.describe with the PEP 723 deps from the dataset folder", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    const datasetDir = path.join(root, "evals/support");
    expect(await describeEvalPy(datasetDir)).toEqual(DESCRIPTION);
    expect(captureCommand).toHaveBeenCalledWith(
      "uvx",
      [
        "--python",
        "3.13",
        "--from",
        `lmnr==${LMNR_PYTHON_VERSION}`,
        "--with",
        "anthropic>=1",
        "python",
        "-m",
        "lmnr.evals.describe",
        "agent/eval.py",
      ],
      expect.objectContaining({ cwd: datasetDir }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "support/agent/eval.py: SupportEval defines run(), so `run_command` is ignored.",
    );
  });

  void it("installs the evals root's pyproject.toml, then PEP 723 deps", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/pyproject.toml",
      '[project]\nname = "evals"\nversion = "0"\ndependencies = ["openai"]\n',
    );
    describeOk();
    await describeEvalPy(path.join(root, "evals/support"));
    expect(vi.mocked(captureCommand).mock.calls[0][1].slice(4, 8)).toEqual([
      "--with-requirements",
      path.join(root, "evals/pyproject.toml"),
      "--with",
      "anthropic>=1",
    ]);
  });

  void it("leaves a pyproject.toml without [project] alone", async () => {
    await write("evals/pyproject.toml", "[tool.ruff]\nline-length = 100\n");
    await write("evals/support/harbor.yaml", "");
    expect(await pythonRequirements(path.join(root, "evals/support"))).toEqual(
      [],
    );
    await write("evals/pyproject.toml", "[project\n");
    await expect(
      pythonRequirements(path.join(root, "evals/support")),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_evals_dir" }));
  });

  void it("uses LMNR_EVAL_LMNR_SPEC instead of the pinned lmnr", () => {
    process.env.LMNR_EVAL_LMNR_SPEC = "/src/lmnr-python";
    expect(describeArgs([]).slice(0, 4)).toEqual([
      "--python",
      "3.13",
      "--from",
      "/src/lmnr-python",
    ]);
  });

  void it("fails with Python's error, without uv's noise", async () => {
    await write("evals/support/agent/eval.py", "");
    vi.mocked(captureCommand).mockResolvedValue({
      code: 2,
      stdout: "",
      stderr:
        "Installed 40 packages in 50ms\n" +
        "agent/eval.py: SupportEval has no image. Set `image = ...`\n",
    });
    await expect(
      describeEvalPy(path.join(root, "evals/support")),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_evals_dir",
        message: expect.stringMatching(
          /Can't load .*eval\.py:\nagent\/eval\.py: SupportEval has no image/,
        ),
      }),
    );
  });
});

void describe("describeEvalPy with an old lmnr", () => {
  void it("says which lmnr eval.py datasets need", async () => {
    await write("evals/support/agent/eval.py", "");
    vi.mocked(captureCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr:
        "python: Error while finding module specification for " +
        "'lmnr.evals.describe' (ModuleNotFoundError: No module named 'lmnr.evals')\n",
    });
    await expect(
      describeEvalPy(path.join(root, "evals/support")),
    ).rejects.toThrow(
      `has no lmnr.evals; eval.py datasets need lmnr>=${LMNR_PYTHON_VERSION}.`,
    );
  });
});

void describe("eval run with an eval.py dataset", () => {
  void it("writes task files, builds the image and runs the runner through Harbor", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/dataset.toml",
      '[dataset]\nname = "acme/support"\n',
    );
    await write("evals/support/tasks/refund/environment/ticket.json", "{}");
    describeOk({
      ...DESCRIPTION,
      images: {
        "support-evals": {
          kind: "generated",
          dockerfile_text: "FROM python:3.13-slim\n",
          context: path.join(root, "evals/support/agent"),
          steps: [],
        },
      },
      modules: ["_shared/support.py", "support/agent/eval.py"],
    });
    const calls: {
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }[] = [];
    let job: Record<string, unknown> = {};
    vi.mocked(runCommand).mockImplementation(async (command, args, opts) => {
      calls.push({ command, args, env: opts?.env });
      if (command === "uvx") {
        job = JSON.parse(await readFile(args[args.indexOf("-c") + 1], "utf8"));
      }
      return 0;
    });

    await handleEvalRun(undefined, { dir: path.join(root, "evals") });

    // The task got the files Harbor needs before it was hashed.
    expect(
      await readFile(
        path.join(root, "evals/support/tasks/refund/task.toml"),
        "utf8",
      ),
    ).toContain('name = "acme/refund"');
    const build = calls.find((c) => c.command === "docker");
    expect(build?.args).toEqual(
      expect.arrayContaining(["build", "-t", "support-evals"]),
    );
    const harbor = calls.find((c) => c.command === "uvx");
    expect(harbor?.args.slice(0, 8)).toEqual([
      "--python",
      "3.13",
      "--from",
      "harbor==0.25.0",
      "--with",
      `lmnr==${LMNR_PYTHON_VERSION}`,
      "--with",
      "anthropic>=1",
    ]);
    // The runner's modules, for the Files view of a remote run.
    expect(harbor?.args).toEqual(
      expect.arrayContaining([
        "--pk",
        'runner_modules=["_shared/support.py","support/agent/eval.py"]',
      ]),
    );
    // Secrets reach the Harbor process, where verify() reads them.
    expect(harbor?.env).toEqual(
      expect.objectContaining({ APP_KEY: "app", JUDGE_KEY: "judge" }),
    );
    expect(job).toEqual({
      agents: [
        {
          import_path: LAMINAR_AGENT_IMPORT_PATH,
          kwargs: { runner: "agent/eval.py:SupportEval" },
          env: { APP_KEY: "${APP_KEY}" },
          model_name: "anthropic/claude-sonnet-5-5",
        },
      ],
      verifier: {
        import_path: LAMINAR_VERIFIER_IMPORT_PATH,
        kwargs: { runner: "agent/eval.py:SupportEval" },
      },
      datasets: [{ path: "tasks" }],
    });
  });

  void it("builds a generated image and keeps its Dockerfile in the job dir", async () => {
    const text =
      "# Generated by lmnr.evals.\n# support/agent/eval.py:5 (SupportEval)\n" +
      "FROM python:3.13-slim\nRUN pip install x\n";
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/refund/task.toml",
      '[task]\nname = "a/b"\n',
    );
    await write("evals/support/jobs/2026-01-01__00-00-00/config.json", "{}");
    describeOk({
      ...DESCRIPTION,
      images: {
        "support-evals": {
          kind: "generated",
          dockerfile_text: text,
          context: path.join(root, "evals"),
          steps: [],
        },
      },
    });
    let built = "";
    const job = path.join(root, "evals/support/jobs/2026-11-26__12-00-00");
    vi.mocked(runCommand).mockImplementation(async (command, args) => {
      if (command === "docker") {
        built = await readFile(args[args.indexOf("-f") + 1], "utf8");
        expect(args.slice(-3)).toEqual([
          "-t",
          "support-evals",
          path.join(root, "evals"),
        ]);
      } else {
        await mkdir(job, { recursive: true });
      }
      return 0;
    });

    await handleEvalRun(undefined, { dir: path.join(root, "evals") });

    expect(built).toBe(text);
    // Next to Harbor's config.json of THIS run's job, comments included.
    expect(
      await readFile(path.join(job, "support-evals.Dockerfile"), "utf8"),
    ).toBe(text);
    // Warnings are logged on every run.
    expect(logger.warn).toHaveBeenCalledWith(
      "support/agent/eval.py: SupportEval defines run(), so `run_command` is ignored.",
    );
  });

  void it("builds a local LMNR_EVAL_LMNR_SPEC into the Laminar layer's wheel", async () => {
    const checkout = path.join(root, "lmnr-python");
    await mkdir(checkout);
    process.env.LMNR_EVAL_LMNR_SPEC = checkout;
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/refund/task.toml",
      '[task]\nname = "a/b"\n',
    );
    const description: EvalDescription = {
      ...DESCRIPTION,
      images: {
        "support-evals": {
          kind: "generated",
          dockerfile_text:
            "FROM python:3.13-slim\nCOPY --from=lmnr-dev / /tmp/\n",
          context: path.join(root, "evals"),
          steps: [],
        },
      },
      laminar_layer: {
        python: "3.13",
        lmnr: null,
        build_contexts: { "lmnr-dev": "lmnr wheel" },
      },
    };
    const uvBuilds: string[][] = [];
    vi.mocked(captureCommand).mockImplementation(async (command, args) => {
      if (command === "uv") {
        uvBuilds.push(args);
        const out = args[args.indexOf("--out-dir") + 1];
        await writeFile(path.join(out, "lmnr-0.9.3-py3-none-any.whl"), "");
        return { code: 0, stdout: "", stderr: "" };
      }
      // describe asks for the wheel, not lmnr==<version>.
      expect(args[args.length - 1]).toBe("--layer-lmnr=wheel");
      return { code: 0, stdout: JSON.stringify(description), stderr: "" };
    });
    let contexts: string[] = [];
    vi.mocked(runCommand).mockImplementation(async (command, args) => {
      if (command === "docker") {
        contexts = args.filter((_, i) => args[i - 1] === "--build-context");
      }
      return 0;
    });

    await handleEvalRun(undefined, { dir: path.join(root, "evals") });

    expect(uvBuilds).toEqual([
      ["build", "--wheel", "--out-dir", expect.any(String), checkout],
    ]);
    expect(contexts).toEqual([`lmnr-dev=${uvBuilds[0][3]}`]);
  });

  void it("passes any other LMNR_EVAL_LMNR_SPEC on to the layer", async () => {
    process.env.LMNR_EVAL_LMNR_SPEC =
      "lmnr @ git+https://github.com/lmnr-ai/lmnr-python@feat/x";
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    await describeEvalPy(path.join(root, "evals/support"));
    const args = vi.mocked(captureCommand).mock.calls[0][1];
    expect(args[args.length - 1]).toBe(
      "--layer-lmnr=lmnr @ git+https://github.com/lmnr-ai/lmnr-python@feat/x",
    );
  });

  void it("fails before running when a secret is unset", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    delete process.env.JUDGE_KEY;
    await expect(
      handleEvalRun(undefined, { dir: path.join(root, "evals") }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "missing_env",
        message: expect.stringMatching(/JUDGE_KEY/),
      }),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  void it("fails before building when Laminar rejects the project key", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    keyCheck.mockResolvedValue(new Response("invalid key", { status: 401 }));
    await expect(
      handleEvalRun(undefined, { dir: path.join(root, "evals") }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "laminar_key_rejected", exitCode: 24 }),
    );
    expect(keyCheck).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

void describe("RYSTIC_TOKEN", () => {
  const RYSTIC: EvalDescription = {
    ...DESCRIPTION,
    services: [
      {
        name: "slack",
        kind: "Rystic",
        version: "1",
        source: null,
        env: ["SLACK_API_URL"],
        origin: null,
      },
    ],
  };

  void it("resolves it for local runs of a dataset with a Rystic mirror", async () => {
    await write(".env", "RYSTIC_TOKEN=from-dotenv\n");
    expect(await withRysticToken({ A: "1" }, { s: RYSTIC }, false)).toEqual({
      A: "1",
      RYSTIC_TOKEN: "from-dotenv",
    });
    process.env.RYSTIC_TOKEN = "from-shell";
    expect(await withRysticToken({}, { s: RYSTIC }, false)).toEqual({
      RYSTIC_TOKEN: "from-shell",
    });
    // --env wins; no Rystic mirror, nothing added.
    expect(
      await withRysticToken({ RYSTIC_TOKEN: "flag" }, { s: RYSTIC }, false),
    ).toEqual({ RYSTIC_TOKEN: "flag" });
    expect(await withRysticToken({}, { s: DESCRIPTION }, false)).toEqual({});
  });

  void it("drops --env RYSTIC_TOKEN on remote runs", async () => {
    process.env.RYSTIC_TOKEN = "from-shell";
    expect(
      await withRysticToken(
        { A: "1", RYSTIC_TOKEN: "flag" },
        { s: RYSTIC },
        true,
      ),
    ).toEqual({ A: "1" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Not sending --env RYSTIC_TOKEN/),
    );
    expect(await withRysticToken({}, { s: RYSTIC }, true)).toEqual({});
  });

  void it("passes it to every agent of a local run, or fails before building", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/refund/task.toml",
      '[task]\nname = "a/b"\n',
    );
    describeOk({
      ...RYSTIC,
      images: {
        "support-evals": {
          kind: "generated",
          dockerfile_text: "FROM python:3.13-slim\n",
          context: path.join(root, "evals"),
          steps: [],
        },
      },
    });
    await expect(
      handleEvalRun(undefined, { dir: path.join(root, "evals") }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "missing_env",
        exitCode: 19,
        message:
          "Rystic mirrors need Rystic access in local (not `--remote`) " +
          "runs. Set RYSTIC_TOKEN to your Rystic API key (in your shell, " +
          ".env.local or .env).",
      }),
    );
    expect(runCommand).not.toHaveBeenCalled();

    await write(".env.local", "RYSTIC_TOKEN=mine\n");
    let job: { agents?: { env?: Record<string, string> }[] } = {};
    let harborEnv: NodeJS.ProcessEnv | undefined;
    vi.mocked(runCommand).mockImplementation(async (command, args, opts) => {
      if (command === "uvx") {
        job = JSON.parse(await readFile(args[args.indexOf("-c") + 1], "utf8"));
        harborEnv = opts?.env;
      }
      return 0;
    });
    await handleEvalRun(undefined, { dir: path.join(root, "evals") });
    expect(job.agents?.[0].env).toEqual(
      expect.objectContaining({ RYSTIC_TOKEN: "${RYSTIC_TOKEN}" }),
    );
    expect(harborEnv?.RYSTIC_TOKEN).toBe("mine");
  });
});

void describe("eval task new", () => {
  const evals = () => ({ dir: path.join(root, "evals") });

  void it("creates a task dir with Harbor's files", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    await handleEvalTaskNew("support", "refund", evals());
    const toml = await readFile(
      path.join(root, "evals/support/tasks/refund/task.toml"),
      "utf8",
    );
    expect(toml).toContain('name = "support/refund"');
    expect(toml).toContain('docker_image = "support-evals"');
    expect(logger.info).toHaveBeenCalledWith(
      "created support/tasks/refund/task.toml",
    );
  });

  void it("finds the dataset by its [dataset] name", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/dataset.toml",
      '[dataset]\nname = "acme/support"\n',
    );
    describeOk();
    await handleEvalTaskNew("acme/support", "refund", { dir: "evals" });
    expect(
      await readFile(
        path.join(root, "evals/support/tasks/refund/task.toml"),
        "utf8",
      ),
    ).toContain('name = "acme/refund"');
  });

  void it("warns about a missing test.sh with grade_with_test_sh", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/refund/task.toml",
      '[task]\nname = "a/b"\n',
    );
    await write("evals/support/tasks/refund/instruction.md", "Do it.\n");
    describeOk({ ...DESCRIPTION, grade_with_test_sh: true });
    const dir = path.join(root, "evals/support/tasks/refund");
    const shown = path.relative(process.cwd(), dir);
    await handleEvalTaskNew("support", "refund", evals());
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("test.sh"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${shown} has no tests/test.sh`),
    );

    // --json too: the warning is on stderr, stdout stays the JSON.
    logger.warn.mockClear();
    const log = vi.spyOn(console, "log").mockReturnValue(undefined);
    await handleEvalTaskNew("support", "refund", { ...evals(), json: true });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      dir,
      files: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${shown} has no tests/test.sh`),
    );
    log.mockRestore();
  });

  void it("needs a known eval.py dataset and a valid name", async () => {
    await write("evals/support/harbor.yaml");
    await expect(
      handleEvalTaskNew("support", "refund", evals()),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_evals_dir",
        message: expect.stringMatching(
          /^Dataset support has no agent\/eval\.py/,
        ),
      }),
    );
    await expect(handleEvalTaskNew("nope", "refund", evals())).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_evals_dir",
        message: expect.stringMatching(/^Unknown dataset nope/),
      }),
    );
    for (const name of ["../escape", "a/b", ".hidden"]) {
      await expect(handleEvalTaskNew("support", name, evals())).rejects.toThrow(
        expect.objectContaining({ code: "invalid_evals_dir" }),
      );
    }
    expect(captureCommand).not.toHaveBeenCalled();
  });
});

void describe("eval describe", () => {
  const RESOLVED: EvalDescription = {
    ...DESCRIPTION,
    runner: "RefundsEval",
    images: {
      "support-evals": {
        kind: "generated",
        dockerfile_text: "FROM python:3.13-slim\n",
        context: "/abs",
        steps: [
          {
            origin: "_shared/support.py:12 (SupportRunner)",
            step: "python 3.13",
          },
          {
            origin: "service: Postgres 16 (_shared/support.py:15)",
            step: "service",
          },
          {
            origin: "_shared/support.py:13 (SupportRunner)",
            step: "apt_install poppler-utils",
          },
        ],
      },
      py: {
        kind: "generated",
        dockerfile_text: "FROM python:3.13-slim\n",
        context: "/abs",
        ignore_file: "/abs/py.Dockerfile.dockerignore",
        steps: [],
      },
    },
    services: [
      {
        name: "postgres",
        kind: "Postgres",
        version: "16",
        source: "postgres:16-bookworm",
        env: ["DATABASE_URL"],
        origin: "_shared/support.py:15 (SupportRunner)",
      },
    ],
    classes: [
      { name: "RefundsEval", file: "support/agent/eval.py" },
      { name: "SupportRunner", file: "_shared/support.py" },
    ],
    new_task_toml: { agent: { timeout_sec: 300 } },
    mocks: [
      {
        key: "crm.get_customer",
        type: "function",
        handler: "_shared.support:get_customer",
      },
      {
        key: "https://api.zendesk.com",
        type: "http",
        handler: "__runner__:zendesk",
        base_url_env: "ZENDESK_URL",
      },
    ],
    mock_dependencies: ["anthropic"],
    laminar_layer: {
      python: "3.13",
      lmnr: "lmnr==0.9.3",
      build_contexts: {},
    },
  };

  const stdout = () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation((s) => {
      writes.push(`${String(s)}\n`);
    });
    return {
      text: () => writes.join(""),
      restore: () => {
        spy.mockRestore();
        log.mockRestore();
      },
    };
  };

  void it("prints each dataset's resolved runner", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write("evals/legacy/harbor.yaml", "datasets: []\n");
    describeOk(RESOLVED);
    const out = stdout();
    try {
      await handleEvalDescribe(undefined, { dir: "evals" });
    } finally {
      out.restore();
    }
    // Relative to the cwd (the test's root).
    const jobs = path.join("evals", "support", "jobs");
    expect(out.text()).toBe(
      [
        "legacy: no agent/eval.py (a harbor.yaml dataset)",
        "",
        "support/agent/eval.py",
        "  runner: RefundsEval",
        "    RefundsEval    support/agent/eval.py",
        "    SupportRunner  _shared/support.py",
        "  model: anthropic/claude-sonnet-5-5",
        "  images:",
        "    support-evals (default; generated, context /abs)",
        "      python 3.13                _shared/support.py:12 (SupportRunner)",
        "      service                    service: Postgres 16 (_shared/support.py:15)",
        "      apt_install poppler-utils  _shared/support.py:13 (SupportRunner)",
        "      generated Dockerfile, kept by each run that builds it:",
        `        local:  ${path.join(jobs, "<job>", "support-evals.Dockerfile")}`,
        "        remote: support/agent/.generated/support-evals.Dockerfile in the run's files",
        "    py (generated, context /abs, ignore file /abs/py.Dockerfile.dockerignore)",
        "      generated Dockerfile, kept by each run that builds it:",
        `        local:  ${path.join(jobs, "<job>", "py.Dockerfile")}`,
        "        remote: support/agent/.generated/py.Dockerfile in the run's files",
        "  services:",
        "    postgres: Postgres 16 from postgres:16-bookworm",
        "      env: DATABASE_URL",
        "      declared at _shared/support.py:15 (SupportRunner)",
        "  mocks:",
        "    crm.get_customer (function): _shared.support:get_customer",
        "    https://api.zendesk.com (http): __runner__:zendesk, base URL in ZENDESK_URL",
        "  mock_dependencies: anthropic",
        "  laminar layer: Python 3.13, lmnr==0.9.3",
        "  secrets: APP_KEY, JUDGE_KEY",
        "  env: APP_KEY",
        "  new_task_toml:",
        "    [agent]",
        "    timeout_sec = 300",
        "  grade_with_test_sh: false",
        "  warnings:",
        "    - SupportEval defines run(), so `run_command` is ignored.",
        "",
      ].join("\n"),
    );
    // The output has the warnings; they aren't logged a second time.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  void it("prints describe's JSON by dataset folder with --json", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write("evals/legacy/harbor.yaml", "datasets: []\n");
    describeOk(RESOLVED);
    const out = stdout();
    try {
      await handleEvalDescribe("support", {
        dir: path.join(root, "evals"),
        json: true,
      });
      expect(JSON.parse(out.text())).toEqual({ support: RESOLVED });
      out.text();
      await handleEvalDescribe("legacy", {
        dir: path.join(root, "evals"),
        json: true,
      });
    } finally {
      out.restore();
    }
    expect(out.text().split("\n")[1]).toBe('{"legacy":null}');
    await expect(
      handleEvalDescribe("nope", { dir: path.join(root, "evals") }),
    ).rejects.toMatchObject({ code: "invalid_evals_dir" });
  });
});
