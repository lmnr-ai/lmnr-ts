import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findInstalledAgents,
  findOnPath,
  isAgentCaller,
  LAUNCHABLE_AGENTS,
} from "./coding-agents";

describe("isAgentCaller", () => {
  it("is false for a person at a terminal", () => {
    expect(isAgentCaller({}, true)).toBe(false);
  });

  it("is true without a TTY", () => {
    expect(isAgentCaller({}, false)).toBe(true);
  });

  it.each(["CLAUDECODE", "AI_AGENT", "CODEX_THREAD_ID", "GEMINI_CLI"])(
    "is true when %s is set, even with a TTY",
    (key) => {
      expect(isAgentCaller({ [key]: "1" }, true)).toBe(true);
    },
  );

  it("ignores an empty agent env var", () => {
    expect(isAgentCaller({ CLAUDECODE: "" }, true)).toBe(false);
  });
});

describe("LAUNCHABLE_AGENTS", () => {
  it("opens every agent interactively, never in headless mode", () => {
    const argv = Object.fromEntries(
      Object.entries(LAUNCHABLE_AGENTS).map(([k, a]) => [k, a.args("TASK")]),
    );
    expect(argv).toEqual({
      "claude-code": ["TASK"],
      codex: ["TASK"],
      cursor: ["TASK"],
      gemini: ["-i", "TASK"],
      opencode: ["--prompt", "TASK"],
      copilot: ["-i", "TASK"],
    });
  });
});

describe("findOnPath / findInstalledAgents", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), "lmnr-path-a-"));
    dirB = mkdtempSync(join(tmpdir(), "lmnr-path-b-"));
  });

  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  const touch = (dir: string, name: string, mode: number): void => {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, mode);
  };

  it("finds an executable in any PATH dir, without running it", () => {
    touch(dirB, "codex", 0o755);
    const env = { PATH: [dirA, dirB].join(delimiter) };
    expect(findOnPath("codex", env, "linux")).toBe(join(dirB, "codex"));
    expect(findOnPath("claude", env, "linux")).toBeNull();
  });

  it("skips a non-executable file on POSIX", () => {
    touch(dirA, "claude", 0o644);
    expect(findOnPath("claude", { PATH: dirA }, "linux")).toBeNull();
  });

  it("tries PATHEXT extensions on Windows", () => {
    touch(dirA, "claude.CMD", 0o644);
    const env = { PATH: dirA, PATHEXT: ".EXE;.CMD" };
    expect(findOnPath("claude", env, "win32")).toBe(join(dirA, "claude.CMD"));
  });

  it("lists installed agents in offer order", () => {
    touch(dirA, "opencode", 0o755);
    touch(dirA, "claude", 0o755);
    touch(dirA, "agent", 0o755); // Cursor's generic alias is not trusted
    expect(findInstalledAgents({ PATH: dirA })).toEqual([
      "claude-code",
      "opencode",
    ]);
  });
});
