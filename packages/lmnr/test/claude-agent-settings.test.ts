import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildProxyFlagSettings,
  readClaudeSettingsEnv,
  resolveTargetUrlFromEnv,
} from "../src/opentelemetry-lib/instrumentation/claude-agent-sdk/proxy";

const PROXY_URL = "http://127.0.0.1:45667";
const UPSTREAM = "https://gateway.example.com";

const ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "CLAUDE_CONFIG_DIR",
];

/**
 * Claude Code resolves its `env` block from settings files with HIGHER priority
 * than the subprocess environment, so rewriting options.env alone leaves the
 * proxy idle when a user keeps ANTHROPIC_BASE_URL in ~/.claude/settings.json
 * (lmnr-ai/lmnr#2167).
 */
void describe("claude agent settings.json handling", () => {
  let tmpDir: string;
  let configDir: string;
  let sessionDir: string;
  let savedEnv: Record<string, string | undefined>;

  const writeSettings = (filePath: string, env: Record<string, string>) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ env }));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-claude-settings-"));
    configDir = path.join(tmpDir, "config");
    sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("reads the user settings env block", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    assert.equal(readClaudeSettingsEnv(sessionDir).ANTHROPIC_BASE_URL, UPSTREAM);
  });

  void it("lets local settings outrank project and user settings", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: "https://user",
    });
    writeSettings(path.join(sessionDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: "https://project",
    });
    writeSettings(path.join(sessionDir, ".claude", "settings.local.json"), {
      ANTHROPIC_BASE_URL: "https://local",
    });

    assert.equal(
      readClaudeSettingsEnv(sessionDir).ANTHROPIC_BASE_URL,
      "https://local",
    );
  });

  void it("ignores missing and malformed settings files", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), "{not json");

    assert.deepEqual(readClaudeSettingsEnv(sessionDir), {});
  });

  void it("uses a settings base URL as the proxy upstream", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    assert.equal(resolveTargetUrlFromEnv({}, undefined, sessionDir), UPSTREAM);
  });

  void it("still lets options.env outrank settings for the upstream", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    const url = resolveTargetUrlFromEnv(
      { ANTHROPIC_BASE_URL: "https://explicit" },
      undefined,
      sessionDir,
    );

    assert.equal(url, "https://explicit");
  });

  void it("pins the base URL to the proxy in the flag settings layer", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal(
      (settings?.env as Record<string, string>).ANTHROPIC_BASE_URL,
      PROXY_URL,
    );
  });

  void it("preserves unrelated caller settings", () => {
    const existing = {
      permissions: { allow: ["Bash(*)"] },
      env: { FOO: "bar" },
    };

    const settings = buildProxyFlagSettings(existing, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    assert.deepEqual(settings?.permissions, { allow: ["Bash(*)"] });
    assert.equal(env.FOO, "bar");
    assert.equal(env.ANTHROPIC_BASE_URL, PROXY_URL);
  });

  void it("blanks redirecting keys instead of dropping them", () => {
    // Settings layers merge per key, so a dropped key keeps its lower-layer value.
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
      HTTPS_PROXY: "http://corp:8080",
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal((settings?.env as Record<string, string>).HTTPS_PROXY, "");
  });

  void it("does not invent provider base URLs the user never configured", () => {
    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    assert.equal(env.ANTHROPIC_BEDROCK_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, undefined);
  });

  void it("pins a provider base URL when the user configured one", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: UPSTREAM,
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal(
      (settings?.env as Record<string, string>).ANTHROPIC_BEDROCK_BASE_URL,
      PROXY_URL,
    );
  });

  void it("merges a settings file path", () => {
    const settingsFile = path.join(tmpDir, "custom.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ model: "sonnet", env: { KEEP: "1" } }),
    );

    const settings = buildProxyFlagSettings(settingsFile, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    assert.equal(settings?.model, "sonnet");
    assert.equal(env.KEEP, "1");
    assert.equal(env.ANTHROPIC_BASE_URL, PROXY_URL);
  });

  void it("leaves an unreadable settings path untouched", () => {
    // Never replace a path we can't read — the CLI may still resolve it.
    const result = buildProxyFlagSettings(
      "/nonexistent/settings.json",
      PROXY_URL,
      sessionDir,
    );

    assert.equal(result, null);
  });

  void it("never modifies settings files on disk", () => {
    const settingsPath = path.join(configDir, "settings.json");
    writeSettings(settingsPath, { ANTHROPIC_BASE_URL: UPSTREAM });
    const before = fs.readFileSync(settingsPath, "utf-8");

    buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal(fs.readFileSync(settingsPath, "utf-8"), before);
  });

  void it("resolves the reported issue 2167 scenario", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
      ANTHROPIC_API_KEY: "sk-user",
    });

    const targetUrl = resolveTargetUrlFromEnv({}, undefined, sessionDir);
    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    // Proxy forwards to the user's real gateway...
    assert.equal(targetUrl, UPSTREAM);
    // ...and the CLI is redirected to the proxy at the highest settings layer.
    assert.equal(env.ANTHROPIC_BASE_URL, PROXY_URL);
    // The user's API key is untouched, so it still merges in from their settings.
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});
