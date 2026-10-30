import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

/**
 * A coding-agent CLI we can hand a task to: started INTERACTIVELY with the task
 * as its first message, so the user watches the work and approves edits as
 * usual. Never a headless/print mode (`claude -p`, `codex exec`, ...).
 */
export interface LaunchableAgent {
  /** Human-facing name (prompts, status lines). */
  label: string;
  /** Binary looked up on PATH. */
  bin: string;
  /** Argv that opens an interactive session with `prompt` already submitted. */
  args: (prompt: string) => string[];
}

/**
 * Agent CLIs `eval setup` can launch, keyed by the `--agent` value, in the
 * order they're offered. The argv shapes come from each CLI's `--help`
 * (checked 2026-10): Claude Code and Codex take the prompt positionally,
 * Gemini and Copilot need `-i` (their `-p` is headless), OpenCode needs
 * `--prompt`. Cursor's CLI is looked up as `cursor-agent`, not its `agent`
 * alias, which is too generic a name to trust on PATH.
 */
export const LAUNCHABLE_AGENTS: Record<string, LaunchableAgent> = {
  "claude-code": {
    label: "Claude Code",
    bin: "claude",
    args: (p) => [p],
  },
  codex: { label: "Codex", bin: "codex", args: (p) => [p] },
  cursor: { label: "Cursor", bin: "cursor-agent", args: (p) => [p] },
  gemini: { label: "Gemini CLI", bin: "gemini", args: (p) => ["-i", p] },
  opencode: {
    label: "OpenCode",
    bin: "opencode",
    args: (p) => ["--prompt", p],
  },
  copilot: { label: "Copilot CLI", bin: "copilot", args: (p) => ["-i", p] },
};

/**
 * Env vars coding agents set in the shells they run commands in. Any of them
 * means an agent is calling us, so launching another agent would nest one
 * inside the other. Found in each CLI's source / binary (2026-10).
 */
const CALLER_AGENT_ENV = [
  "CLAUDECODE", // Claude Code
  "AI_AGENT", // Claude Code, and a cross-tool convention
  "CODEX_THREAD_ID", // Codex
  "CODEX_SANDBOX", // Codex
  "CODEX_CI", // Codex
  "GEMINI_CLI", // Gemini CLI
  "OPENCODE", // OpenCode
];

/**
 * True when we're probably running under a coding agent rather than a person:
 * a known agent env var is set, or stdin/stdout isn't a terminal (agents run
 * commands without a TTY, and a prompt could never be answered anyway).
 */
export const isAgentCaller = (
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): boolean => !tty || CALLER_AGENT_ENV.some((k) => Boolean(env[k]));

/**
 * Find `bin` on PATH without running it (running six CLIs' `--version` would
 * cost seconds). On Windows, tries each PATHEXT extension.
 */
export const findOnPath = (
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        accessSync(
          candidate,
          platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
};

/** Keys of {@link LAUNCHABLE_AGENTS} whose binary is on PATH, in offer order. */
export const findInstalledAgents = (
  env: NodeJS.ProcessEnv = process.env,
): string[] =>
  Object.entries(LAUNCHABLE_AGENTS)
    .filter(([, agent]) => findOnPath(agent.bin, env) !== null)
    .map(([key]) => key);

/**
 * Start `agent` interactively with `prompt` on our terminal and wait for it to
 * exit. Resolves the agent's exit code, or `null` when it couldn't be started
 * (the caller falls back to printing the prompt).
 *
 * Ctrl-C reaches the whole foreground process group, so we ignore SIGINT while
 * the agent runs: the agent decides what Ctrl-C means, and we don't exit and
 * leave it orphaned on the terminal.
 */
export const launchAgent = (
  agent: LaunchableAgent,
  prompt: string,
): Promise<number | null> =>
  new Promise((resolve) => {
    // cross-spawn quotes args for cmd.exe, but a newline still ends the command
    // line there; the prompt reads fine as one paragraph.
    const text =
      process.platform === "win32" ? prompt.replace(/\s*\n+\s*/g, " ") : prompt;
    const ignoreSigint = () => {
      // the agent handles Ctrl-C
    };
    process.on("SIGINT", ignoreSigint);
    const done = (code: number | null) => {
      process.off("SIGINT", ignoreSigint);
      resolve(code);
    };
    const child = spawn(agent.bin, agent.args(text), { stdio: "inherit" });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code ?? 1));
  });

/**
 * Copy `text` with the platform's clipboard tool: pbcopy, clip, or on Linux
 * wl-copy / xclip / xsel. Returns false when none worked.
 */
export const copyToClipboard = (text: string): boolean => {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of candidates) {
    try {
      // stdout/stderr ignored, not piped: xclip and wl-copy fork a process that
      // keeps the clipboard and would hold a pipe open, hanging spawnSync.
      const r = spawn.sync(cmd, args, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
      });
      if (!r.error && r.status === 0) return true;
    } catch {
      // try the next tool
    }
  }
  return false;
};
