import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildProxyFlagSettings,
  createProxyInstance,
  getEnvVarsToRemove,
  isProviderEnabledInEnv,
  readClaudeSettingsEnv,
  resolveTargetUrlFromEnv,
  stopProxyInstance,
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
  "http_proxy",
  "https_proxy",
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

  void it("gates which layers are read on settingSources", () => {
    // The CLI honors options.settingSources, so we must too. Reading a layer it
    // was told to ignore would resolve an upstream the CLI never uses.
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: "https://user",
    });
    writeSettings(path.join(sessionDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: "https://project",
    });

    assert.equal(
      readClaudeSettingsEnv(sessionDir, ["user"]).ANTHROPIC_BASE_URL,
      "https://user",
    );
    assert.equal(
      readClaudeSettingsEnv(sessionDir, ["project"]).ANTHROPIC_BASE_URL,
      "https://project",
    );
  });

  void it("disables on-disk settings when settingSources is empty", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    assert.deepEqual(readClaudeSettingsEnv(sessionDir, []), {});
  });

  void it("ignores a layer the CLI will not load when resolving upstream", () => {
    writeSettings(path.join(sessionDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    // The CLI only loads user settings, so the project gateway must be invisible.
    const url = resolveTargetUrlFromEnv({}, undefined, sessionDir, ["user"]);

    assert.equal(url, "https://api.anthropic.com");
  });

  void it("ignores missing and malformed settings files", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), "{not json");

    assert.deepEqual(readClaudeSettingsEnv(sessionDir), {});
  });

  void it("uses an options.settings gateway as the upstream", () => {
    // The flag layer outranks every on-disk layer inside the CLI, and
    // buildProxyFlagSettings is about to overwrite its base URLs with the proxy —
    // so resolution must read it first or the gateway is silently lost.
    const existing = { env: { ANTHROPIC_BASE_URL: UPSTREAM } };

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir, undefined, existing),
      UPSTREAM,
    );
  });

  void it("uses an options.settings provider gateway as the upstream", () => {
    const existing = {
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_BEDROCK_BASE_URL: UPSTREAM,
      },
    };

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir, undefined, existing),
      UPSTREAM,
    );
  });

  void it("uses an options.settings file gateway as the upstream", () => {
    const settingsFile = path.join(tmpDir, "caller.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: UPSTREAM } }),
    );

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir, undefined, settingsFile),
      UPSTREAM,
    );
  });

  void it("still lets options.env outrank options.settings", () => {
    const existing = { env: { ANTHROPIC_BASE_URL: UPSTREAM } };

    const url = resolveTargetUrlFromEnv(
      { ANTHROPIC_BASE_URL: "https://explicit" },
      undefined,
      sessionDir,
      undefined,
      existing,
    );

    assert.equal(url, "https://explicit");
  });

  void it("lets options.settings outrank the on-disk layers", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: "https://ondisk",
    });
    const existing = { env: { ANTHROPIC_BASE_URL: UPSTREAM } };

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir, undefined, existing),
      UPSTREAM,
    );
  });

  void it("ignores an unreadable options.settings when resolving upstream", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    for (const bad of ["{not json}", "/nonexistent.json"]) {
      assert.equal(
        resolveTargetUrlFromEnv({}, undefined, sessionDir, undefined, bad),
        UPSTREAM,
      );
    }
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

  for (const value of ["1", "true", "True", " on ", "yes"]) {
    void it(`treats options.env flag ${JSON.stringify(value)} as enabled`, () => {
      // The subprocess-env pin path must agree with getEnvVarsToRemove, which
      // strips ANTHROPIC_FOUNDRY_RESOURCE for any truthy value. A narrower check
      // there strips the resource with no base URL pinned and the CLI hard-fails
      // ("Must provide one of the baseURL or resource arguments").
      const env = { CLAUDE_CODE_USE_FOUNDRY: value };

      assert.equal(isProviderEnabledInEnv(env, "CLAUDE_CODE_USE_FOUNDRY"), true);
      assert.ok(
        getEnvVarsToRemove(env, sessionDir).includes(
          "ANTHROPIC_FOUNDRY_RESOURCE",
        ),
      );
    });
  }

  void it("does not treat a falsy options.env flag as enabled", () => {
    const env = { CLAUDE_CODE_USE_FOUNDRY: "0" };

    assert.equal(isProviderEnabledInEnv(env, "CLAUDE_CODE_USE_FOUNDRY"), false);
    assert.ok(
      !getEnvVarsToRemove(env, sessionDir).includes(
        "ANTHROPIC_FOUNDRY_RESOURCE",
      ),
    );
  });

  void it("tolerates a non-string provider flag in options.settings", () => {
    // options.settings may carry JSON booleans / numbers, and those reach
    // isTruthyEnv, which lowercases the value — an uncoerced bool used to throw.
    const settings = buildProxyFlagSettings(
      { env: { CLAUDE_CODE_USE_FOUNDRY: true } },
      PROXY_URL,
      sessionDir,
    );
    const env = settings?.env as Record<string, string>;

    assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, PROXY_URL);
  });

  void it("tolerates a numeric provider flag in options.settings", () => {
    const settings = buildProxyFlagSettings(
      { env: { CLAUDE_CODE_USE_VERTEX: 1 } },
      PROXY_URL,
      sessionDir,
    );
    const env = settings?.env as Record<string, string>;

    assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, PROXY_URL);
  });

  void it("blanks a lowercase proxy var from settings", () => {
    // Claude Code reads the lowercase spelling too (and prefers it), so handling
    // only the uppercase form lets a lowercase corporate proxy divert traffic.
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
      https_proxy: "http://corp:8080",
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal((settings?.env as Record<string, string>).https_proxy, "");
  });

  void it("does not let a lowercase settings proxy var shadow the gateway", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
      https_proxy: "http://corp:8080",
    });

    assert.equal(resolveTargetUrlFromEnv({}, undefined, sessionDir), UPSTREAM);
  });

  void it("treats a lowercase process-env proxy var as the upstream", () => {
    process.env.https_proxy = "http://corp:8080";

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir),
      "http://corp:8080",
    );
  });

  for (const value of ["1", "true", "True", " on ", "yes"]) {
    void it(`pins the provider base URL when the flag is ${JSON.stringify(value)}`, () => {
      // The CLI accepts 1/true/yes/on — verified against the bundled binary.
      // Missing one would blank the Foundry resource without pinning a base URL.
      writeSettings(path.join(configDir, "settings.json"), {
        CLAUDE_CODE_USE_FOUNDRY: value,
        ANTHROPIC_FOUNDRY_RESOURCE: "myres",
      });

      const env = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir)
        ?.env as Record<string, string>;

      assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, PROXY_URL);
      assert.equal(env.ANTHROPIC_FOUNDRY_RESOURCE, "");
    });
  }

  for (const value of ["0", "false", "no", "off", ""]) {
    void it(`does not pin a provider base URL when the flag is ${JSON.stringify(value)}`, () => {
      writeSettings(path.join(configDir, "settings.json"), {
        CLAUDE_CODE_USE_VERTEX: value,
      });

      const env = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir)
        ?.env as Record<string, string>;

      assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, undefined);
    });
  }

  void it("does not let a settings proxy var shadow the gateway", () => {
    // HTTP_PROXY / HTTPS_PROXY are forward proxies, not API bases. They outrank
    // every base URL, so taking them from settings would make a corporate proxy
    // shadow the gateway beside it and forward API calls to the wrong host.
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
      HTTPS_PROXY: "http://corp:8080",
    });

    assert.equal(resolveTargetUrlFromEnv({}, undefined, sessionDir), UPSTREAM);
  });

  void it("falls back to the default when settings define only a proxy var", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      HTTPS_PROXY: "http://corp:8080",
    });

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir),
      "https://api.anthropic.com",
    );
  });

  void it("still treats a process-env proxy var as the upstream", () => {
    // Pre-existing behavior: a proxy var in the real env IS the target.
    writeSettings(path.join(configDir, "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });
    process.env.HTTPS_PROXY = "http://corp:8080";

    assert.equal(
      resolveTargetUrlFromEnv({}, undefined, sessionDir),
      "http://corp:8080",
    );
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

  void it("pins the Foundry base URL when Foundry is configured by resource alone", () => {
    // Foundry can be set up with ANTHROPIC_FOUNDRY_RESOURCE and no base-URL key.
    // Blanking the resource without pinning a base URL would strip its only
    // routing key and leave nothing for the CLI to talk to.
    writeSettings(path.join(configDir, "settings.json"), {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "myresource",
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, PROXY_URL);
    assert.equal(env.ANTHROPIC_FOUNDRY_RESOURCE, "");
  });

  void it("blanks the Foundry resource when Foundry is enabled only in settings", () => {
    // The resource is mutually exclusive with the base URL we pin — the CLI
    // hard-fails with "baseURL and resource are mutually exclusive" if both are
    // live, so a resource left in the process env must still be blanked.
    writeSettings(path.join(configDir, "settings.json"), {
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = "stray-resource";

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);
    const env = settings?.env as Record<string, string>;

    assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, PROXY_URL);
    assert.equal(env.ANTHROPIC_FOUNDRY_RESOURCE, "");
  });

  void it("strips the Foundry resource from options.env via settings", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });

    assert.ok(
      getEnvVarsToRemove({}, sessionDir).includes("ANTHROPIC_FOUNDRY_RESOURCE"),
    );
  });

  void it("blanks a process-env proxy var in the flag settings", () => {
    process.env.HTTPS_PROXY = "http://corp:8080";

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal((settings?.env as Record<string, string>).HTTPS_PROXY, "");
  });

  void it("pins a provider base URL when only the enabling flag is set", () => {
    writeSettings(path.join(configDir, "settings.json"), {
      CLAUDE_CODE_USE_VERTEX: "1",
    });

    const settings = buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal(
      (settings?.env as Record<string, string>).ANTHROPIC_VERTEX_BASE_URL,
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

  void it("leaves a malformed settings file untouched", () => {
    // Emitting a proxy-only blob here would silently drop the model /
    // permissions the user configured for this run.
    const settingsFile = path.join(tmpDir, "trailing-comma.json");
    fs.writeFileSync(
      settingsFile,
      '{"model": "sonnet", "permissions": {"allow": ["Bash(*)"]},}',
    );

    assert.equal(
      buildProxyFlagSettings(settingsFile, PROXY_URL, sessionDir),
      null,
    );
  });

  void it("leaves a non-object settings file untouched", () => {
    const settingsFile = path.join(tmpDir, "array.json");
    fs.writeFileSync(settingsFile, '["a", "b"]');

    assert.equal(
      buildProxyFlagSettings(settingsFile, PROXY_URL, sessionDir),
      null,
    );
  });

  void it("leaves non-object inline settings untouched", () => {
    assert.equal(buildProxyFlagSettings("{}[]", PROXY_URL, sessionDir), null);
  });

  void it("still applies the proxy to a valid but empty settings file", () => {
    // A genuinely empty settings object is readable — it must NOT be skipped.
    const settingsFile = path.join(tmpDir, "empty.json");
    fs.writeFileSync(settingsFile, "{}");

    const settings = buildProxyFlagSettings(
      settingsFile,
      PROXY_URL,
      sessionDir,
    );

    assert.equal(
      (settings?.env as Record<string, string>).ANTHROPIC_BASE_URL,
      PROXY_URL,
    );
  });

  void it("never modifies settings files on disk", () => {
    const settingsPath = path.join(configDir, "settings.json");
    writeSettings(settingsPath, { ANTHROPIC_BASE_URL: UPSTREAM });
    const before = fs.readFileSync(settingsPath, "utf-8");

    buildProxyFlagSettings(undefined, PROXY_URL, sessionDir);

    assert.equal(fs.readFileSync(settingsPath, "utf-8"), before);
  });

  void it("forwards to a project-settings gateway when cwd differs", async () => {
    // The proxy must forward to the same upstream the caller resolved. Without
    // the session cwd, a gateway that lives only in project settings is missed
    // and the proxy silently forwards to the default Anthropic API.
    writeSettings(path.join(sessionDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: UPSTREAM,
    });

    const targetUrl = resolveTargetUrlFromEnv({}, undefined, sessionDir);
    const instance = await createProxyInstance({ env: {}, cwd: sessionDir });

    try {
      assert.equal(targetUrl, UPSTREAM);
      assert.equal(instance?.targetUrl, UPSTREAM);
    } finally {
      stopProxyInstance(instance);
    }
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
