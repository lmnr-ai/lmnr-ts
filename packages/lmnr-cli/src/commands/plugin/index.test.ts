import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildInstallCommands, renderCommand, writeAgentConfig } from "./index";

// AgentSpec is internal; reconstruct the fields the exported helpers read.
const claudeSpec = {
  label: "Claude Code",
  hostCli: "claude",
  marketplaceRef: "lmnr-ai/lmnr-claude-code-plugin",
  pluginRef: "laminar@laminar",
  installArgv: ["install", "laminar@laminar", "--scope", "user"],
  configFile: "claude-code-plugin.json",
} as any;

const codexSpec = {
  label: "Codex",
  hostCli: "codex",
  marketplaceRef: "lmnr-ai/lmnr-codex-plugin",
  pluginRef: "laminar@laminar",
  installArgv: ["add", "laminar@laminar"],
  configFile: "codex-plugin.json",
} as any;

describe("buildInstallCommands", () => {
  it("claude: marketplace add (lenient) then `plugin install ... --scope user` (fatal)", () => {
    const cmds = buildInstallCommands(claudeSpec);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].argv).toEqual([
      "plugin", "marketplace", "add", "lmnr-ai/lmnr-claude-code-plugin",
    ]);
    expect(cmds[0].lenient).toBe(true);
    expect(cmds[1].argv).toEqual(["plugin", "install", "laminar@laminar", "--scope", "user"]);
    expect(cmds[1].lenient).toBe(false);
  });

  it("codex: marketplace add then `plugin add` (no scope flag)", () => {
    const cmds = buildInstallCommands(codexSpec);
    expect(cmds[0].argv).toEqual(["plugin", "marketplace", "add", "lmnr-ai/lmnr-codex-plugin"]);
    expect(cmds[1].argv).toEqual(["plugin", "add", "laminar@laminar"]);
  });

  it("no secret ever appears in the install commands (key is file-delivered)", () => {
    for (const spec of [claudeSpec, codexSpec]) {
      const joined = buildInstallCommands(spec)
        .map((c) => c.argv.join(" "))
        .join(" ");
      expect(joined).not.toContain("--config");
      expect(joined.toLowerCase()).not.toContain("api");
    }
  });
});

describe("renderCommand", () => {
  it("prefixes the host CLI and joins argv", () => {
    const claudeArgv = ["plugin", "install", "laminar@laminar", "--scope", "user"];
    expect(renderCommand("claude", claudeArgv)).toBe(
      "claude plugin install laminar@laminar --scope user",
    );
    expect(renderCommand("codex", ["plugin", "add", "laminar@laminar"])).toBe(
      "codex plugin add laminar@laminar",
    );
  });
});

describe("writeAgentConfig", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lmnr-cfg-"));
    saved.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = home;
  });
  afterEach(() => {
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes {projectApiKey, baseUrl} to ~/.config/lmnr/<agent>-plugin.json at mode 0600", () => {
    const p = writeAgentConfig(codexSpec, "SECRET_KEY", "https://api.lmnr.ai");
    expect(p).toBe(join(home, "lmnr", "codex-plugin.json"));
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(parsed).toEqual({ projectApiKey: "SECRET_KEY", baseUrl: "https://api.lmnr.ai" });
    // 0600: owner read/write only.
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
