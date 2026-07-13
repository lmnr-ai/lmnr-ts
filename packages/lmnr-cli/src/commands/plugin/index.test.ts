import { describe, expect, it } from "vitest";

import {
  type AgentSpec,
  buildCodexLauncherSource,
  buildInstallCommands,
  renderCommand,
  upsertCodexHookConfig,
} from "./index";

// AgentSpec is not exported (internal registry shape); reconstruct the minimal
// fields buildInstallCommands reads. Kept in sync with the claude-code entry.
const spec = {
  label: "Claude Code",
  marketplaceRef: "lmnr-ai/lmnr-claude-code-plugin",
  pluginRef: "laminar@laminar",
  keyEnvName: "LMNR_PROJECT_API_KEY",
  hostCli: "claude",
  installer: "claude-plugin",
} satisfies AgentSpec;

describe("buildInstallCommands", () => {
  it("emits marketplace-add then install, with the key in --config and user scope", () => {
    const cmds = buildInstallCommands(spec, "SECRET_KEY");
    expect(cmds).toHaveLength(2);

    expect(cmds[0].argv).toEqual([
      "plugin",
      "marketplace",
      "add",
      "lmnr-ai/lmnr-claude-code-plugin",
    ]);
    // marketplace-add is lenient: re-running (already added) must not fail the flow.
    expect(cmds[0].lenient).toBe(true);

    expect(cmds[1].argv).toEqual([
      "plugin",
      "install",
      "laminar@laminar",
      "--config",
      "LMNR_PROJECT_API_KEY=SECRET_KEY",
      "--scope",
      "user",
    ]);
    // install failure IS fatal.
    expect(cmds[1].lenient).toBe(false);
  });
});

describe("codex hook install helpers", () => {
  it("writes a private launcher that injects Laminar config before loading the hook", () => {
    const source = buildCodexLauncherSource({
      hookPath: "/Users/me/.codex/lmnr/hook.cjs",
      apiKey: "SECRET_KEY",
      baseUrl: "https://api.lmnr.ai",
    });

    expect(source).toContain('process.env.LMNR_PROJECT_API_KEY = "SECRET_KEY";');
    expect(source).toContain('process.env.LMNR_BASE_URL = "https://api.lmnr.ai";');
    expect(source).toContain('require("/Users/me/.codex/lmnr/hook.cjs");');
  });

  it("adds hooks=true and a single Laminar Stop hook block", () => {
    const input = `model = "openai.gpt-5.5"

[features]
shell_tool = true

# >>> Laminar Codex plugin
old block
# <<< Laminar Codex plugin
`;

    const output = upsertCodexHookConfig(input, "/Users/me/.codex/lmnr/hook-launcher.cjs");

    expect(output).toContain("[features]\nhooks = true\nshell_tool = true");
    expect(output).toContain("[[hooks.Stop]]");
    expect(output).toContain("[[hooks.Stop.hooks]]");
    expect(output).toContain('type = "command"');
    expect(output).toContain(
      'command = "node /Users/me/.codex/lmnr/hook-launcher.cjs"',
    );
    expect(output.match(/Laminar Codex plugin/g)).toHaveLength(2);
    expect(output).not.toContain("old block");
  });
});

describe("renderCommand", () => {
  const argv = [
    "plugin",
    "install",
    "laminar@laminar",
    "--config",
    "LMNR_PROJECT_API_KEY=SECRET_KEY",
    "--scope",
    "user",
  ];

  it("shows the full key when not masking (copy-paste path)", () => {
    expect(renderCommand("claude", argv, false)).toBe(
      "claude plugin install laminar@laminar --config LMNR_PROJECT_API_KEY=SECRET_KEY --scope user",
    );
  });

  it("masks only the --config value when masking (echo-to-terminal path)", () => {
    const out = renderCommand("claude", argv, true);
    expect(out).toBe(
      "claude plugin install laminar@laminar --config LMNR_PROJECT_API_KEY=*** --scope user",
    );
    expect(out).not.toContain("SECRET_KEY");
  });

  it("leaves a bare --config token untouched when it has no '='", () => {
    // Defensive: a value-less --config shouldn't throw or mangle.
    expect(renderCommand("claude", ["--config", "NOEQUALS"], true)).toBe(
      "claude --config NOEQUALS",
    );
  });
});
