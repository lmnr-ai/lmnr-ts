import type {
  HostedEvalRunLogLine,
  HostedEvalRunLogPage,
  HostedEvalSandboxStatus,
} from "@lmnr-ai/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunLogShipper, followRunLog } from "./run-log";

afterEach(() => {
  vi.restoreAllMocks();
});

void describe("createRunLogShipper", () => {
  void it("numbers plain-text lines, holds back an unfinished one and sends it on close", async () => {
    const batches: HostedEvalRunLogLine[][] = [];
    const onStarted = vi.fn();
    const shipper = createRunLogShipper(async (lines) => {
      batches.push(lines);
      return true;
    }, onStarted);

    const write = shipper.writer();
    write("\x1b[32;20mone\x1b[0m\r\ntw");
    write("o\nthree");
    await shipper.close();

    expect(batches.flat().map((l) => [l.seq, l.text])).toEqual([
      [0, "one"],
      [1, "two"],
      [2, "three"],
    ]);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  void it("keeps each source's unfinished line to itself", async () => {
    const sent: string[] = [];
    const shipper = createRunLogShipper(async (lines) => {
      sent.push(...lines.map((l) => l.text));
      return true;
    });
    const out = shipper.writer();
    const err = shipper.writer();
    out("Traceback (most rec");
    err("WARN: retrying\n");
    out("ent call last):\n");
    await shipper.close();

    expect(sent).toEqual([
      "WARN: retrying",
      "Traceback (most recent call last):",
    ]);
  });

  void it("splits a large backlog into ordered batches of at most 500", async () => {
    const batches: HostedEvalRunLogLine[][] = [];
    const shipper = createRunLogShipper(async (lines) => {
      batches.push(lines);
      return true;
    });
    shipper.writer()("x\n".repeat(1200));
    await shipper.close();

    expect(batches.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(batches.flat().map((l) => l.seq)).toEqual(
      Array.from({ length: 1200 }, (_, i) => i),
    );
  });

  void it("resends a failed batch, then goes on in order", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sent: number[][] = [];
    let calls = 0;
    const shipper = createRunLogShipper(async (lines) => {
      calls += 1;
      if (calls === 1) throw new Error("502");
      sent.push(lines.map((l) => l.seq));
      return true;
    });
    shipper.writer()("a\nb\n");
    await shipper.close();

    expect(sent).toEqual([[0, 1]]);
  });

  void it("stops for good when the server keeps no run logs", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const send = vi.fn(async () => false);
    const onStarted = vi.fn();
    const shipper = createRunLogShipper(send, onStarted);
    const write = shipper.writer();
    write("a\n");
    await shipper.close();
    write("b\n");
    await shipper.close();

    expect(send).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/doesn't keep run logs/),
    );
  });
});

const page = (
  from: number,
  texts: string[],
  exitCode: number | null = null,
): HostedEvalRunLogPage => ({
  lines: texts.map((text, i) => ({ seq: from + i, time: 0, text })),
  next: from + texts.length,
  exitCode,
});

/** A fake clock that `sleep` advances, so polling runs instantly. */
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

void describe("followRunLog", () => {
  void it("prints lines from where the last page ended until the exit code", async () => {
    const pages = [page(0, ["a", "b"]), page(2, []), page(2, ["c"], 18)];
    const getRunLogs = vi.fn(
      async (_id: string, _from: number) => pages.shift() ?? null,
    );
    const out: string[] = [];

    const result = await followRunLog(
      { getRunLogs, getSandbox: vi.fn() },
      "up-1",
      "sb-1",
      { write: (t) => out.push(t), ...clock() },
    );

    expect(result).toEqual({ kind: "exited", exitCode: 18 });
    expect(out.join("")).toBe("a\nb\nc\n");
    expect(getRunLogs.mock.calls.map((c) => c[1])).toEqual([0, 2, 2]);
  });

  void it("reads the next page right away while pages come back full", async () => {
    const full = Array.from({ length: 1000 }, () => "x");
    const pages = [page(0, full), page(1000, [], 0)];
    const time = clock();
    const sleep = vi.fn(time.sleep);

    const result = await followRunLog(
      { getRunLogs: async () => pages.shift() ?? null, getSandbox: vi.fn() },
      "up-1",
      "sb-1",
      { write: () => undefined, now: time.now, sleep },
    );

    expect(result).toEqual({ kind: "exited", exitCode: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  void it("gives up on a quiet run whose orchestrator sandbox is gone", async () => {
    const getSandbox = vi.fn(
      async (): Promise<HostedEvalSandboxStatus> => ({
        state: "error",
        errorReason: "out of memory",
      }),
    );

    const result = await followRunLog(
      { getRunLogs: async () => page(0, []), getSandbox },
      "up-1",
      "sb-1",
      { write: () => undefined, ...clock() },
    );

    expect(result).toEqual({
      kind: "lost",
      state: "error",
      reason: "out of memory",
    });
    expect(getSandbox).toHaveBeenCalledTimes(1);
  });

  void it("gives up when the orchestrator sandbox is no longer found", async () => {
    const result = await followRunLog(
      { getRunLogs: async () => page(0, []), getSandbox: async () => null },
      "up-1",
      "sb-1",
      { write: () => undefined, ...clock() },
    );

    expect(result).toEqual({ kind: "lost", state: "destroyed" });
  });

  void it("goes on when checking the sandbox fails", async () => {
    let reads = 0;
    const getSandbox = vi.fn(async () => {
      throw new Error("502");
    });
    const result = await followRunLog(
      {
        getRunLogs: async () => {
          reads += 1;
          return page(0, [], reads > 40 ? 0 : null);
        },
        getSandbox,
      },
      "up-1",
      "sb-1",
      { write: () => undefined, ...clock() },
    );

    expect(result).toEqual({ kind: "exited", exitCode: 0 });
    expect(getSandbox).toHaveBeenCalledTimes(2);
  });

  void it("keeps an exit code that lands while the sandbox is checked", async () => {
    let reads = 0;
    const result = await followRunLog(
      {
        getRunLogs: async () => {
          reads += 1;
          return reads > 16 ? page(0, ["done"], 0) : page(0, []);
        },
        getSandbox: async () => ({ state: "destroyed" }),
      },
      "up-1",
      "sb-1",
      { write: () => undefined, ...clock() },
    );

    expect(result).toEqual({ kind: "exited", exitCode: 0 });
  });

  void it("retries read errors and reports a server without run logs", async () => {
    let reads = 0;
    const result = await followRunLog(
      {
        getRunLogs: async () => {
          reads += 1;
          if (reads < 3) throw new Error("ECONNRESET");
          return null;
        },
        getSandbox: vi.fn(),
      },
      "up-1",
      "sb-1",
      { write: () => undefined, ...clock() },
    );

    expect(result).toEqual({ kind: "unsupported" });
    expect(reads).toBe(3);
  });
});
