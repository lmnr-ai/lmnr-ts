import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeArgs, describeEvalPy } from "./describe";
import {
  type EvalDescription,
  LAMINAR_AGENT_IMPORT_PATH,
  LAMINAR_VERIFIER_IMPORT_PATH,
} from "./eval-py";
import { LMNR_PYTHON_VERSION } from "./harbor";
import { handleEvalRun } from "./index";
import { captureCommand, runCommand } from "./run-command";
import { handleEvalTaskNew } from "./task-files";

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
      kind: "dockerfile",
      dockerfile: "/abs/Dockerfile",
      context: "/abs",
    },
  },
  default_image: "support-evals",
  model: "anthropic/claude-sonnet-5-5",
  env: { APP_KEY: "${APP_KEY}" },
  secrets: ["APP_KEY", "JUDGE_KEY"],
  task_template: {},
  verify: "runner",
  warnings: ["SupportEval defines run(), so `entrypoint` is ignored."],
};

const describeOk = (description: EvalDescription = DESCRIPTION) =>
  vi.mocked(captureCommand).mockResolvedValue({
    code: 0,
    stdout: JSON.stringify(description),
    stderr: "Installed 40 packages in 50ms\n",
  });

beforeEach(async () => {
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
  vi.mocked(runCommand).mockReset();
  vi.mocked(captureCommand).mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  for (const key of [
    "LMNR_PROJECT_API_KEY",
    "APP_KEY",
    "JUDGE_KEY",
    "LMNR_EVAL_LMNR_SPEC",
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
      "support/agent/eval.py: SupportEval defines run(), so `entrypoint` is ignored.",
    );
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
    await write("evals/support/agent/Dockerfile", "FROM python:3.13-slim\n");
    describeOk({
      ...DESCRIPTION,
      images: {
        "support-evals": {
          kind: "dockerfile",
          dockerfile: path.join(root, "evals/support/agent/Dockerfile"),
          context: path.join(root, "evals/support/agent"),
        },
      },
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
});

void describe("eval task new", () => {
  void it("creates a task dir with Harbor's files", async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    describeOk();
    await handleEvalTaskNew(path.join(root, "evals/support/tasks/refund"), {});
    const toml = await readFile(
      path.join(root, "evals/support/tasks/refund/task.toml"),
      "utf8",
    );
    expect(toml).toContain('name = "support/refund"');
    expect(toml).toContain('docker_image = "support-evals"');
  });

  void it('warns about a missing test.sh with verify = "task"', async () => {
    await write("evals/support/agent/eval.py", EVAL_PY);
    await write(
      "evals/support/tasks/refund/task.toml",
      '[task]\nname = "a/b"\n',
    );
    await write("evals/support/tasks/refund/instruction.md", "Do it.\n");
    describeOk({ ...DESCRIPTION, verify: "task" });
    const dir = path.join(root, "evals/support/tasks/refund");
    await handleEvalTaskNew(dir, {});
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("test.sh"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${dir} has no tests/test.sh`),
    );

    // --json too: the warning is on stderr, stdout stays the JSON.
    logger.warn.mockClear();
    const log = vi.spyOn(console, "log").mockReturnValue(undefined);
    await handleEvalTaskNew(dir, { json: true });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      dir,
      files: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${dir} has no tests/test.sh`),
    );
    log.mockRestore();
  });

  void it("needs <dataset>/tasks/<name> of an eval.py dataset", async () => {
    await write("evals/support/harbor.yaml");
    await expect(
      handleEvalTaskNew(path.join(root, "evals/support/tasks/refund"), {}),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_evals_dir" }));
    await expect(
      handleEvalTaskNew(path.join(root, "evals/support/refund"), {}),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_evals_dir" }));
  });
});
