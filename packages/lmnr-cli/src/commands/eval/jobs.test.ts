import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findJobDir,
  MAX_JOB_BYTES,
  MAX_JOB_FILE_BYTES,
  packJobDir,
  readTrialOutcomes,
  trialException,
} from "./jobs";

let root: string;

const write = async (rel: string, content: string | Buffer = "x") => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lmnr-jobs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

void describe("packJobDir", () => {
  void it("packs trial dirs and their artifacts, without steps' artifacts or big files", async () => {
    await write("config.json", "{}");
    await write("job.log", "job");
    await write(".sources/t/task.toml", "");
    await write("hello__abc/trial.log", "trial");
    await write("hello__abc/agent/oracle.txt", "agent");
    await write("hello__abc/artifacts/manifest.json", "[]");
    await write("hello__abc/artifacts/logs/artifacts/state.db", "db");
    await write("hello__abc/steps/one/agent/out.txt", "step");
    await write("hello__abc/steps/one/artifacts/big.bin", "a");
    await write(
      "hello__abc/agent/huge.txt",
      Buffer.alloc(MAX_JOB_FILE_BYTES + 1),
    );

    const { index, skipped } = await packJobDir(root);

    expect(index.map((f) => f.path)).toEqual([
      "hello__abc/agent/oracle.txt",
      "hello__abc/artifacts/logs/artifacts/state.db",
      "hello__abc/artifacts/manifest.json",
      "hello__abc/steps/one/agent/out.txt",
      "hello__abc/trial.log",
    ]);
    expect(skipped).toEqual(["hello__abc/agent/huge.txt"]);
  });

  void it("packs artifacts last, so they never push out a trial's logs", async () => {
    // Exactly the cap, plus one more file; `artifacts/` sorts before
    // `trial.log` and `verifier/`, so in name order it would take the budget.
    const big = Buffer.alloc(MAX_JOB_BYTES / 8);
    for (let i = 0; i < 9; i++) {
      await write(`a__1/artifacts/state/${i}.bin`, big);
    }
    await write("a__1/trial.log", "trial");
    await write("a__1/verifier/test-stdout.txt", "graded");
    await write("b__2/trial.log", "next trial");

    const { index, skipped } = await packJobDir(root);
    const paths = index.map((f) => f.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "a__1/trial.log",
        "a__1/verifier/test-stdout.txt",
        "b__2/trial.log",
      ]),
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((p) => p.startsWith("a__1/artifacts/"))).toBe(true);
    expect(paths).toEqual([...paths].sort());
  });
});

void describe("findJobDir", () => {
  void it("finds the job Harbor named, or nothing when it wrote none", async () => {
    expect(await findJobDir(path.join(root, "missing"))).toBeUndefined();
    await write(".lock", "");
    expect(await findJobDir(root)).toBeUndefined();
    await write("2026-11-12__09-40-03/config.json", "{}");
    expect(await findJobDir(root)).toBe(
      path.join(root, "2026-11-12__09-40-03"),
    );
  });
});

const exception = (type: string, message = "boom") => ({
  exception_type: type,
  exception_message: message,
  exception_traceback: "Traceback ...",
  occurred_at: "2026-11-27T10:00:00Z",
});

void describe("trialException", () => {
  void it("counts a trial that raised and got no reward", () => {
    expect(
      trialException({
        exception_info: exception("RuntimeError", "no app"),
        verifier_result: null,
      }),
    ).toEqual({ type: "RuntimeError", message: "no app" });
    expect(
      trialException({
        exception_info: exception("RuntimeError"),
        verifier_result: { rewards: {} },
      }),
    ).toMatchObject({ type: "RuntimeError" });
    // A multi-step trial records it on the step.
    expect(
      trialException({
        exception_info: null,
        step_results: [
          { exception_info: null },
          { exception_info: exception("StepError") },
        ],
      }),
    ).toMatchObject({ type: "StepError" });
  });

  void it("doesn't count a graded trial or one that didn't raise", () => {
    // An agent timeout that was still graded is a result.
    expect(
      trialException({
        exception_info: exception("AgentTimeoutError"),
        verifier_result: { rewards: { reward: 0 } },
      }),
    ).toBeUndefined();
    expect(
      trialException({ exception_info: null, verifier_result: null }),
    ).toBeUndefined();
    expect(trialException("not a result")).toBeUndefined();
  });
});

void describe("readTrialOutcomes", () => {
  void it("counts the job's trials with a result and the errored ones", async () => {
    await write("result.json", "{}");
    await write("config.json", "{}");
    await write(
      "b__2/result.json",
      JSON.stringify({ exception_info: exception("SecondError") }),
    );
    await write(
      "a__1/result.json",
      JSON.stringify({ exception_info: exception("FirstError", "first") }),
    );
    await write(
      "c__3/result.json",
      JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
    );
    // Unfinished: no result yet.
    await write("d__4/trial.log", "");
    await write(".sources/x/result.json", "{}");

    expect(await readTrialOutcomes(root)).toEqual({
      total: 3,
      errored: 2,
      firstError: { type: "FirstError", message: "first" },
    });
    expect(await readTrialOutcomes(undefined)).toEqual({
      total: 0,
      errored: 0,
    });
  });
});
