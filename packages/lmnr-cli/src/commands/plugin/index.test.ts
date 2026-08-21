import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENTS, renderCommand, writeAgentConfig } from "./index";

describe("AGENTS install commands", () => {
  it("claude: marketplace add (lenient) then `plugin install ... --scope user` (fatal)", () => {
    const cmds = AGENTS["claude-code"].installCommands;
    expect(cmds).toHaveLength(2);
    expect(cmds[0].argv).toEqual([
      "plugin",
      "marketplace",
      "add",
      "lmnr-ai/lmnr-claude-code-plugin",
    ]);
    expect(cmds[0].lenient).toBe(true);
    expect(cmds[1].argv).toEqual([
      "plugin",
      "install",
      "lmnr@lmnr",
      "--scope",
      "user",
    ]);
    expect(cmds[1].lenient).toBeFalsy();
  });

  it("codex: marketplace add then `plugin add` (no scope flag)", () => {
    const cmds = AGENTS.codex.installCommands;
    expect(cmds[0].argv).toEqual([
      "plugin",
      "marketplace",
      "add",
      "lmnr-ai/lmnr-codex-plugin",
    ]);
    expect(cmds[1].argv).toEqual(["plugin", "add", "lmnr@lmnr"]);
  });

  it("pi: one fatal `pi install npm:@lmnr-ai/pi-extension` (no marketplace, global)", () => {
    const cmds = AGENTS.pi.installCommands;
    expect(cmds).toHaveLength(1);
    expect(cmds[0].argv).toEqual(["install", "npm:@lmnr-ai/pi-extension"]);
    expect(cmds[0].lenient).toBeFalsy();
    // `-l` would scope the install to .pi/settings.json, breaking the
    // directory-independent contract of `plugin add`.
    expect(cmds[0].argv).not.toContain("-l");
  });

  it("no secret ever appears in the install commands (key is file-delivered)", () => {
    for (const spec of Object.values(AGENTS)) {
      const joined = spec.installCommands
        .map((c) => c.argv.join(" "))
        .join(" ");
      expect(joined).not.toContain("--config");
      expect(joined.toLowerCase()).not.toContain("api");
    }
  });

  it("every agent has a non-empty probe and a config file", () => {
    for (const [agent, spec] of Object.entries(AGENTS)) {
      expect(spec.probeArgv.length, agent).toBeGreaterThan(0);
      expect(spec.installCommands.length, agent).toBeGreaterThan(0);
      expect(spec.configFile, agent).toMatch(/\.json$/);
      expect(["plugin", "extension"], agent).toContain(spec.noun);
    }
  });

  it("config file names are unique per agent (no cross-agent key clobbering)", () => {
    const files = Object.values(AGENTS).map((s) => s.configFile);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("renderCommand", () => {
  it("prefixes the host CLI and joins argv", () => {
    const claudeArgv = ["plugin", "install", "lmnr@lmnr", "--scope", "user"];
    expect(renderCommand("claude", claudeArgv)).toBe(
      "claude plugin install lmnr@lmnr --scope user",
    );
    expect(renderCommand("codex", ["plugin", "add", "lmnr@lmnr"])).toBe(
      "codex plugin add lmnr@lmnr",
    );
    expect(renderCommand("pi", ["install", "npm:@lmnr-ai/pi-extension"])).toBe(
      "pi install npm:@lmnr-ai/pi-extension",
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
    const p = writeAgentConfig(
      AGENTS.codex,
      "SECRET_KEY",
      "https://api.lmnr.ai",
    );
    expect(p).toBe(join(home, "lmnr", "codex-plugin.json"));
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(parsed).toEqual({
      projectApiKey: "SECRET_KEY",
      baseUrl: "https://api.lmnr.ai",
    });
    // 0600: owner read/write only.
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("writes pi's key to pi-extension.json, where the pi extension reads it", () => {
    const p = writeAgentConfig(
      AGENTS.pi,
      "SECRET_KEY",
      "http://localhost:8000",
    );
    expect(p).toBe(join(home, "lmnr", "pi-extension.json"));
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(parsed).toEqual({
      projectApiKey: "SECRET_KEY",
      baseUrl: "http://localhost:8000",
    });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
