import { describe, expect, it, vi } from "vitest";

import { runCommand } from "./run-command";

void describe("runCommand", () => {
  void it("ends each output sink before it resolves", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const events: string[] = [];
    const sink = (name: string) => ({
      write: (chunk: string) => events.push(`${name}:${chunk}`),
      end: () => events.push(`${name}:end`),
    });

    const code = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('no newline'); process.stderr.write('e')"],
      { output: { stdout: sink("out"), stderr: sink("err") } },
    );

    expect(code).toBe(0);
    expect(events.filter((e) => e.startsWith("out:"))).toEqual([
      "out:no newline",
      "out:end",
    ]);
    expect(events.filter((e) => e.startsWith("err:"))).toEqual([
      "err:e",
      "err:end",
    ]);
    vi.restoreAllMocks();
  });
});
