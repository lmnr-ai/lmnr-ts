import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// handleEvalSetup = runSetup + questions + handoff. The seams (setup steps,
// agent detection/launch, clipboard, the manifest scan, readline) are mocked;
// the suite checks which path each situation takes and what the agent is told.

const h = vi.hoisted(() => ({
  runSetup: vi.fn(),
  isAgentCaller: vi.fn(),
  findInstalledAgents: vi.fn(),
  launchAgent: vi.fn(),
  copyToClipboard: vi.fn(),
  findLaminarSdk: vi.fn(),
  findInstalledSkillDirs: vi.fn(),
  answers: [] as string[],
  questions: [] as string[],
}));

vi.mock("../setup", () => ({ runSetup: h.runSetup }));
vi.mock("../../utils/coding-agents", async (importActual) => ({
  ...(await importActual<typeof import("../../utils/coding-agents")>()),
  isAgentCaller: h.isAgentCaller,
  findInstalledAgents: h.findInstalledAgents,
  launchAgent: h.launchAgent,
  copyToClipboard: h.copyToClipboard,
}));
vi.mock("../../utils/install-skill", () => ({
  findInstalledSkillDirs: h.findInstalledSkillDirs,
}));
vi.mock("./instrumentation", () => ({ findLaminarSdk: h.findLaminarSdk }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      h.questions.push(q);
      const answer = h.answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${q}`);
      return answer;
    },
    close: () => undefined,
  }),
}));

import { LAUNCHABLE_AGENTS } from "../../utils/coding-agents";
import { buildEvalSetupPrompt, handleEvalSetup } from "./setup";

const SKILL = ".claude/skills/laminar/SKILL.md";

let stdout: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.answers = [];
  h.questions = [];
  stdout = "";
  h.runSetup.mockResolvedValue({
    projectId: "p1",
    projectName: "Proj",
    workspaceName: "WS",
    userEmail: "dev@example.com",
    skillsInstalled: [`${process.cwd()}/${SKILL}`],
    skillSkipped: false,
  });
  h.isAgentCaller.mockReturnValue(false);
  h.findInstalledAgents.mockReturnValue([]);
  h.findLaminarSdk.mockResolvedValue([]);
  h.findInstalledSkillDirs.mockResolvedValue([]);
  h.copyToClipboard.mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildEvalSetupPrompt", () => {
  it("names the skill path, eval run, and the user's choice", () => {
    const prompt = buildEvalSetupPrompt("add", SKILL);
    expect(prompt).toContain(`the Laminar skill (\`${SKILL}\`)`);
    expect(prompt).toContain("`lmnr-cli eval run`");
    expect(prompt).toContain("Instrument it first");
  });

  it("tells the agent not to add tracing when the user declined", () => {
    const prompt = buildEvalSetupPrompt("skip", SKILL);
    expect(prompt).toContain("chose not to instrument it");
    expect(prompt).toContain("Don't add Laminar tracing");
  });

  it("has the agent check and ask when nobody could be asked", () => {
    expect(buildEvalSetupPrompt("unknown", SKILL)).toContain(
      "ask the user whether to instrument it",
    );
  });

  it("falls back to `skill add` when no skill is installed", () => {
    expect(buildEvalSetupPrompt("already", null)).toContain(
      "npx lmnr-cli skill add",
    );
  });
});

describe("handleEvalSetup", () => {
  it("runs the setup steps quietly with the passed-through options", async () => {
    h.isAgentCaller.mockReturnValue(true);
    await handleEvalSetup({ browser: false, projectId: "p1" });
    expect(h.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ quiet: true, browser: false, projectId: "p1" }),
    );
  });

  it("never lets the setup steps prompt when an agent is the caller", async () => {
    h.isAgentCaller.mockReturnValue(true);
    await handleEvalSetup({});
    expect(h.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false }),
    );
  });

  it("lets the setup steps prompt for a person at a terminal", async () => {
    h.answers = ["y", ""];
    await handleEvalSetup({});
    expect(h.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
  });

  it("prints the prompt and asks nothing when an agent is the caller", async () => {
    h.isAgentCaller.mockReturnValue(true);
    h.findInstalledAgents.mockReturnValue(["claude-code"]);
    await handleEvalSetup({});
    expect(stdout).toBe(`${buildEvalSetupPrompt("unknown", SKILL)}\n`);
    expect(h.questions).toEqual([]);
    expect(h.launchAgent).not.toHaveBeenCalled();
    expect(h.copyToClipboard).not.toHaveBeenCalled();
  });

  it("--json emits the prompt and the user's choice", async () => {
    await handleEvalSetup({ json: true, instrumentation: "already" });
    expect(JSON.parse(stdout)).toEqual({
      projectId: "p1",
      projectName: "Proj",
      workspaceName: "WS",
      instrumentation: "already",
      skillPath: SKILL,
      prompt: buildEvalSetupPrompt("already", SKILL),
    });
  });

  it("asks, then launches the only installed agent with the prompt", async () => {
    h.findInstalledAgents.mockReturnValue(["codex"]);
    h.launchAgent.mockResolvedValue(0);
    // instrumented? no → instrument? yes → open Codex? (default yes)
    h.answers = ["n", "y", ""];
    await handleEvalSetup({});
    expect(h.launchAgent).toHaveBeenCalledWith(
      LAUNCHABLE_AGENTS.codex,
      buildEvalSetupPrompt("add", SKILL),
    );
    expect(h.questions[2]).toContain("Open Codex with this task?");
    // Shown once, before the question.
    expect(stdout).toBe(`${buildEvalSetupPrompt("add", SKILL)}\n\n`);
  });

  it("defaults the first question to yes when the SDK is in a manifest", async () => {
    h.findLaminarSdk.mockResolvedValue(["package.json"]);
    h.findInstalledAgents.mockReturnValue(["claude-code"]);
    h.launchAgent.mockResolvedValue(0);
    h.answers = ["", ""];
    await handleEvalSetup({});
    expect(h.questions[0]).toContain("[Y/n]");
    expect(h.launchAgent).toHaveBeenCalledWith(
      LAUNCHABLE_AGENTS["claude-code"],
      buildEvalSetupPrompt("already", SKILL),
    );
  });

  it("offers a picker when several agents are installed", async () => {
    h.findInstalledAgents.mockReturnValue(["claude-code", "cursor"]);
    h.launchAgent.mockResolvedValue(0);
    h.answers = ["2"];
    await handleEvalSetup({ instrumentation: "skip" });
    expect(h.launchAgent).toHaveBeenCalledWith(
      LAUNCHABLE_AGENTS.cursor,
      buildEvalSetupPrompt("skip", SKILL),
    );
  });

  it("prints the prompt and only copies it when the user says so", async () => {
    h.findInstalledAgents.mockReturnValue(["claude-code"]);
    // open Claude Code? no → copy? (default no)
    h.answers = ["n", ""];
    await handleEvalSetup({ instrumentation: "already" });
    expect(h.launchAgent).not.toHaveBeenCalled();
    // Not printed a second time after the decline.
    expect(stdout).toBe(`${buildEvalSetupPrompt("already", SKILL)}\n\n`);
    expect(h.questions[1]).toContain("[y/N]");
    expect(h.copyToClipboard).not.toHaveBeenCalled();
  });

  it("falls back to printing when the agent can't be started", async () => {
    h.findInstalledAgents.mockReturnValue(["gemini"]);
    h.launchAgent.mockResolvedValue(null);
    h.answers = ["y", "y"];
    await handleEvalSetup({ instrumentation: "add" });
    const prompt = buildEvalSetupPrompt("add", SKILL);
    expect(stdout).toContain(prompt);
    expect(h.copyToClipboard).toHaveBeenCalledWith(prompt);
  });

  it("--copy copies without asking", async () => {
    await handleEvalSetup({ instrumentation: "add", copy: true });
    expect(h.questions).toEqual([]);
    expect(h.copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it("--agent that isn't installed falls back to printing", async () => {
    h.findInstalledAgents.mockReturnValue(["claude-code"]);
    h.answers = [""];
    await handleEvalSetup({ instrumentation: "add", agent: "codex" });
    expect(h.launchAgent).not.toHaveBeenCalled();
    expect(stdout).toContain(buildEvalSetupPrompt("add", SKILL));
  });

  it("rejects an unknown --agent with unsupported_agent (13)", async () => {
    await expect(handleEvalSetup({ agent: "vim" })).rejects.toThrow(
      "process.exit(13)",
    );
    expect(exitSpy).toHaveBeenCalledWith(13);
    expect(h.runSetup).not.toHaveBeenCalled();
  });

  it("points at an earlier install when this run's skill refresh was skipped", async () => {
    h.isAgentCaller.mockReturnValue(true);
    h.runSetup.mockResolvedValue({
      projectId: "p1",
      projectName: null,
      workspaceName: null,
      userEmail: null,
      skillsInstalled: [],
      skillSkipped: true,
    });
    h.findInstalledSkillDirs.mockResolvedValue([".agents"]);
    await handleEvalSetup({ instrumentation: "already" });
    expect(stdout).toContain("`.agents/skills/laminar/SKILL.md`");
  });
});
