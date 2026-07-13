import { describe, expect, it } from "vitest";

import { buildInstallCommands, renderCommand } from "./index";

// AgentSpec is not exported (internal registry shape); reconstruct the minimal
// fields buildInstallCommands reads. Kept in sync with the claude-code entry.
const spec = {
  label: "Claude Code",
  marketplaceRef: "lmnr-ai/lmnr-claude-code-plugin",
  pluginRef: "laminar@laminar",
  keyEnvName: "LMNR_PROJECT_API_KEY",
  hostCli: "claude",
} as any;

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
