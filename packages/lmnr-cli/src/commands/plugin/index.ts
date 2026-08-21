import { type StdioOptions } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { type CliProject } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

import { version } from "../../../package.json";
import { mintProjectApiKey } from "../../auth/api-key";
import {
  type Credentials,
  globalLmnrDirectory,
  safeReadCredentials,
} from "../../auth/credentials";
import { SessionExpiredError } from "../../auth/resolve";
import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../../constants";
import {
  configWriteFailed,
  EXIT_INSTALL_FAILED,
  failWith,
  listProjectsFailed,
  loginFailed,
  mintFailed,
  noAccess,
  noProject,
  projectAmbiguous,
  unsupportedAgent,
} from "../../errors";
import { orange, pc } from "../../utils/colors";
// emitError is still used by the one bespoke install-failure site (below), which
// emits a full result JSON rather than the generic failWith envelope.
import { emitError } from "../../utils/output";
import { listProjects, promptProjectChoice } from "../../utils/projects";
import { firstNonEmpty } from "../../utils/text";
import { handleLogin } from "../login";

/** One install step: argv after the host CLI, plus how to treat a non-zero exit. */
export interface HostCommand {
  argv: string[];
  /**
   * Non-zero exit is benign — warn and keep going. Set on `marketplace add`,
   * which fails when the marketplace is already registered. Omit (the default)
   * for steps whose failure must abort the install.
   */
  lenient?: boolean;
}

/**
 * Registry of agents `plugin add <agent>` can wire up, keyed by the CLI argument
 * the user types. Every agent shares one shape: a host CLI that can install the
 * Laminar add-on non-interactively, and a per-agent config file under
 * `~/.config/lmnr/` that carries the project API key. No agent has a per-add-on
 * secret store, so the key lives in that file and the add-on reads it, which
 * keeps it out of argv, terminal scrollback, and shell history.
 *
 * How the install itself happens varies: Claude Code and Codex have native plugin
 * marketplaces, Pi installs an npm package. So a spec just lists the commands to
 * run, verbatim. Adding an agent = one entry.
 */
export interface AgentSpec {
  /** Human-facing label (banners, minted-key name). */
  label: string;
  /** What this host calls a Laminar add-on: "plugin" or "extension". */
  noun: string;
  /** Host CLI binary that performs the install (`claude`, `codex`, `pi`). */
  hostCli: string;
  /**
   * Argv proving the host CLI exists AND is new enough to speak the install verb.
   * A missing binary or an unknown subcommand both exit non-zero, so one `--help`
   * call covers both. Cheaper and more robust than parsing a version string.
   */
  probeArgv: string[];
  /** Install steps, run in order. */
  installCommands: HostCommand[];
  /** Per-user config file (under ~/.config/lmnr) the add-on reads the key from. */
  configFile: string;
  /**
   * Host-specific imperative for activating the freshly installed add-on.
   * Claude Code exposes `/reload-plugins` (reloads hooks in-session, no restart);
   * Codex and Pi have no in-session reload, so they restart.
   */
  activationHint: string;
}

export const AGENTS: Record<string, AgentSpec> = {
  "claude-code": {
    label: "Claude Code",
    noun: "plugin",
    hostCli: "claude",
    probeArgv: ["plugin", "--help"],
    installCommands: [
      {
        argv: [
          "plugin",
          "marketplace",
          "add",
          "lmnr-ai/lmnr-claude-code-plugin",
        ],
        lenient: true,
      },
      { argv: ["plugin", "install", "lmnr@lmnr", "--scope", "user"] },
    ],
    configFile: "claude-code-plugin.json",
    activationHint: "Run `/reload-plugins`",
  },
  codex: {
    label: "Codex",
    noun: "plugin",
    hostCli: "codex",
    probeArgv: ["plugin", "--help"],
    installCommands: [
      {
        argv: ["plugin", "marketplace", "add", "lmnr-ai/lmnr-codex-plugin"],
        lenient: true,
      },
      { argv: ["plugin", "add", "lmnr@lmnr"] },
    ],
    configFile: "codex-plugin.json",
    activationHint: "Restart Codex",
  },
  // Registry key, `hostCli`, and the package name stay lowercase (they are literal
  // argv); only the display label is capitalized.
  pi: {
    label: "Pi",
    noun: "extension",
    hostCli: "pi",
    probeArgv: ["install", "--help"],
    // Pi has no marketplace: `pi install` adds the package to ~/.pi/agent/settings.json
    // and installs it under ~/.pi/agent/npm/. Global by default (no `-l`), matching
    // this command's directory-independent contract.
    installCommands: [{ argv: ["install", "npm:@lmnr-ai/pi-extension"] }],
    configFile: "pi-extension.json",
    activationHint: "Restart Pi",
  },
};

export interface PluginAddOptions {
  projectId?: string;
  printOnly?: boolean;
  json?: boolean;
  /** Set by commander's `--no-browser`; false suppresses the device-flow open. */
  browser?: boolean;
  frontendUrl?: string;
  baseUrl?: string;
}

interface PluginAddResult {
  agent: string;
  projectId: string;
  projectName: string | null;
  workspaceName: string | null;
  apiKey: string;
  apiKeyId: string | null;
  /** Path to the per-agent config file the key was written to. */
  configPath: string;
  /** true when we ran the host-CLI install; false when we only printed commands. */
  installed: boolean;
  /** The `<cli> plugin ...` commands, as copy-pasteable strings. */
  commands: string[];
  /** Coded error when install failed (JSON still emits the full result so a
   *  caller can recover the key + commands); absent on success. */
  error?: string;
}

/**
 * `plugin add <agent>`: onboard the Laminar add-on for a coding agent.
 *
 * Flow: log in (device flow) if needed → pick the project that should receive
 * this agent's traces (deliberately NOT the directory-linked app project) →
 * mint a project API key named after the add-on+host → write it to
 * `~/.config/lmnr/<agent>-{plugin,extension}.json` (where the add-on reads it) →
 * run the spec's install commands, or print them when the host CLI is missing /
 * `--print-only`.
 *
 * Unlike `setup`, this is GLOBAL and directory-independent: it never reads or
 * writes `.lmnr/project.json` or `.env`. The key never passes through the host
 * CLI's argv — it lives only in the per-agent config file (no agent has a
 * per-add-on secret store), so the install commands carry no secret.
 */
export const handlePluginAdd = async (
  agent: string,
  options: PluginAddOptions,
): Promise<void> => {
  const isJson = options.json === true;
  const spec = AGENTS[agent];
  if (!spec) {
    failWith(
      isJson,
      unsupportedAgent(
        `Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(", ")}.`,
      ),
    );
  }

  const frontendUrl = firstNonEmpty(
    options.frontendUrl,
    process.env.LMNR_FRONTEND_URL,
    DEFAULT_FRONTEND_URL,
  );
  const baseUrl = firstNonEmpty(
    options.baseUrl,
    process.env.LMNR_BASE_URL,
    DEFAULT_BASE_URL,
  );

  if (!isJson) {
    process.stderr.write(
      `\n${orange("Laminar CLI")} ${pc.dim(`v${version}`)}\n`,
    );
    process.stderr.write(
      pc.dim(`Setting up the Laminar ${spec.noun} for ${spec.label}.\n\n`),
    );
  }

  // --- 1. Login ------------------------------------------------------------
  let creds = await safeReadCredentials();
  let loginProjectId: string | null = null;
  if (!creds) {
    let login;
    try {
      login = await handleLogin({
        frontendUrl,
        noBrowser: options.browser === false,
      });
    } catch (err) {
      failWith(isJson, loginFailed(errorMessage(err)));
    }
    loginProjectId = login.projectId;
    creds = await safeReadCredentials();
    if (!creds) {
      failWith(isJson, loginFailed("credentials missing after login"));
    }
  }

  const issuer = creds.issuer || frontendUrl;
  if (!isJson) {
    process.stderr.write(
      `${pc.green("✓")} Logged in as ${creds.userEmail ?? "<unknown>"}\n`,
    );
  }

  // --- 2. Project selection (deliberate — the dedicated coding-agent project) --
  const project = await resolveProject(
    creds,
    baseUrl,
    options,
    loginProjectId,
    isJson,
  );
  if (!isJson) {
    process.stderr.write(
      `${pc.green("✓")} Traces will go to project ${project.name || project.id}` +
        (project.workspaceName ? pc.dim(` (${project.workspaceName})`) : "") +
        "\n",
    );
  }

  // --- 3. Mint an add-on-named key -----------------------------------------
  const keyName = `${spec.label} ${spec.noun} @ ${hostname()}`;
  let key;
  try {
    key = await mintProjectApiKey(
      issuer,
      creds.sessionToken,
      project.id,
      keyName,
    );
  } catch (err) {
    failWith(isJson, mintFailed(errorMessage(err)));
  }
  if (!isJson) {
    process.stderr.write(
      `${pc.green("✓")} Minted a project API key named "${pc.bold(keyName)}"\n`,
    );
  }

  // --- 4. Write the per-agent config file the plugin reads -----------------
  let configPath: string;
  try {
    configPath = writeAgentConfig(spec, key.apiKey, baseUrl);
  } catch (err) {
    failWith(isJson, configWriteFailed(errorMessage(err)));
  }
  if (!isJson) {
    process.stderr.write(`${pc.green("✓")} Wrote ${configPath}\n`);
  }

  // --- 5. Install via the host CLI, or print the commands ------------------
  const hostCommands = spec.installCommands;
  const commands = hostCommands.map((c) => renderCommand(spec.hostCli, c.argv));
  const canRun = !options.printOnly && hostCliCanInstall(spec);

  // Shared by the success summary and the JSON failure path, so a caller always
  // gets the minted key + commands regardless of outcome.
  const makeResult = (
    didInstall: boolean,
    error?: string,
  ): PluginAddResult => ({
    agent,
    projectId: project.id,
    projectName: project.name || null,
    workspaceName: project.workspaceName || null,
    apiKey: key.apiKey,
    apiKeyId: key.apiKeyId ?? null,
    configPath,
    installed: didInstall,
    commands,
    ...(error ? { error } : {}),
  });

  let installed = false;
  if (canRun) {
    installed = await runInstall(spec, hostCommands, isJson);
    if (!installed) {
      if (isJson) {
        // Key is already minted/on disk — emit the full result so a caller can recover it.
        process.stdout.write(
          JSON.stringify(makeResult(false, "install_failed")) + "\n",
        );
      } else {
        printCommands(spec, hostCommands, false, "install-failed");
        emitError(
          false,
          "install_failed",
          `A \`${spec.hostCli}\` command failed; commands printed above.`,
        );
      }
      process.exit(EXIT_INSTALL_FAILED);
    }
  } else {
    printCommands(
      spec,
      hostCommands,
      isJson,
      options.printOnly ? "print-only" : "no-host-cli",
    );
  }

  // --- 6. Summary ----------------------------------------------------------
  const result = makeResult(installed);

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (installed) {
    process.stdout.write(
      `\n${pc.green("✓")} ${spec.label} ${spec.noun} installed.\n\n` +
        `Next steps:\n` +
        `  1. ${pc.bold(spec.activationHint)} to activate the ${spec.noun}.\n` +
        `  2. Use ${spec.label} as usual — every run becomes a Laminar trace.\n`,
    );
  } else {
    process.stdout.write(
      `\nRun the commands above to finish, then activate the ${spec.noun} ` +
        `(${pc.bold(spec.activationHint)}).\n`,
    );
  }
};

// ---------------------------------------------------------------------------
// Project selection
// ---------------------------------------------------------------------------

/**
 * Pick the project this agent's traces go to. `--project-id` wins (validated
 * against accessible projects). Otherwise: 0 → instruct to create one; 1 →
 * auto-select; >1 → interactive picker (or require --project-id in --json).
 *
 * We nudge toward a DEDICATED project so agent traces don't mix into an app's
 * project. When we just logged in and the browser handed back a selected/created
 * project (loginProjectId), that's honored as the deliberate choice.
 */
const resolveProject = async (
  creds: Credentials,
  baseUrl: string,
  options: PluginAddOptions,
  loginProjectId: string | null,
  isJson: boolean,
): Promise<CliProject> => {
  // Mirror setup: a discovery failure gets the coded envelope + exit, not a bare
  // main().catch stderr line (which --json callers can't parse).
  let projects: CliProject[];
  try {
    projects = await listProjects(creds, baseUrl);
  } catch (err) {
    // An expired grant surfaces here via listProjects → refreshIfNeeded. Map it
    // to login_failed (6), like setup / project link — not a discovery failure.
    if (err instanceof SessionExpiredError) {
      failWith(
        isJson,
        loginFailed("Session expired. Run `lmnr-cli login` first."),
      );
    }
    failWith(isJson, listProjectsFailed(errorMessage(err)));
  }

  if (options.projectId) {
    const match = projects.find((p) => p.id === options.projectId);
    if (!match) {
      failWith(
        isJson,
        noAccess(
          `You don't have access to project ${options.projectId}. Accessible: ` +
            projects
              .map((p) => `${p.id} (${p.workspaceName}/${p.name})`)
              .join(", "),
        ),
      );
    }
    return match;
  }

  // Browser-selected/created project from a fresh login is the deliberate choice.
  if (loginProjectId) {
    const match = projects.find((p) => p.id === loginProjectId);
    if (match) return match;
    // Metadata id we can't see in the list (fresh/other workspace) — trust it.
    return { id: loginProjectId, name: "", workspaceId: "", workspaceName: "" };
  }

  if (projects.length === 0) {
    failWith(
      isJson,
      noProject(
        `No projects found. Create one in the dashboard, then re-run \`lmnr-cli plugin add\`.`,
      ),
    );
  }
  if (projects.length === 1) {
    return projects[0];
  }
  if (isJson) {
    failWith(
      isJson,
      projectAmbiguous(
        `Multiple projects: pass --project-id <id>. ` +
          projects
            .map((p) => `${p.id} (${p.workspaceName}/${p.name})`)
            .join(", "),
      ),
    );
  }
  return promptProjectChoice(
    projects,
    "\nPick the project to send this agent's traces to " +
      pc.dim(
        "(a dedicated project keeps agent traces separate from your app traces)",
      ) +
      ":\n",
  );
};

// ---------------------------------------------------------------------------
// Per-agent config file
// ---------------------------------------------------------------------------

/**
 * Write the per-agent Laminar config (`~/.config/lmnr/<spec.configFile>`, mode
 * 0600). This is the sole delivery channel for the project API key: every add-on
 * reads it from here (no agent has a per-add-on secret store), so the key never
 * has to pass through the host CLI's argv. Returns the path.
 */
export const writeAgentConfig = (
  spec: AgentSpec,
  apiKey: string,
  baseUrl: string,
): string => {
  const dir = globalLmnrDirectory();
  // recursive == `mkdir -p` (no error if it exists). 0700 not 0600: a dir needs the
  // execute bit to traverse into it; the key file itself is written 0600 below.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, spec.configFile);
  const body =
    JSON.stringify({ projectApiKey: apiKey, baseUrl }, null, 2) + "\n";
  writeFileSync(filePath, body, { mode: 0o600 });
  // `mode` only applies on create; chmod so a re-run can't leave an existing file looser.
  chmodSync(filePath, 0o600);
  return filePath;
};

// ---------------------------------------------------------------------------
// Host-CLI native install
// ---------------------------------------------------------------------------

/**
 * Probe whether the host CLI is present AND speaks its install verb, by running
 * the spec's `probeArgv`. A missing binary throws / exits non-zero, and so does a
 * CLI too old for the subcommand.
 */
export const hostCliCanInstall = (spec: AgentSpec): boolean => {
  try {
    const r = spawn.sync(spec.hostCli, spec.probeArgv, { encoding: "utf-8" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
};

/**
 * Run the install commands in order, narrating each. A lenient step's non-zero
 * exit is warned-and-continued (e.g. marketplace already added); a non-lenient
 * failure returns false. No secret is on the command line (the key is in the
 * config file), so the commands are echoed verbatim.
 */
const runInstall = async (
  spec: AgentSpec,
  commands: HostCommand[],
  isJson: boolean,
): Promise<boolean> => {
  if (!isJson) process.stderr.write("\n");
  for (const cmd of commands) {
    if (!isJson) {
      process.stderr.write(
        `${pc.dim(`$ ${renderCommand(spec.hostCli, cmd.argv)}`)}\n`,
      );
    }
    const code = await runChild(spec.hostCli, cmd.argv, isJson);
    if (code !== 0) {
      if (cmd.lenient) {
        if (!isJson) {
          process.stderr.write(
            `${pc.yellow("⚠")} \`${renderCommand(spec.hostCli, cmd.argv)}\` exited ${code} ` +
              `(continuing — usually means already configured)\n`,
          );
        }
        continue;
      }
      return false;
    }
  }
  return true;
};

// In --json mode the child's stdout goes to our stderr (fd 2) so its chatter
// can't pollute the single JSON line we print on stdout.
const runChild = (
  cmd: string,
  argv: string[],
  isJson: boolean,
): Promise<number> =>
  new Promise((resolve) => {
    const stdio: StdioOptions = isJson ? ["inherit", 2, "inherit"] : "inherit";
    const child = spawn(cmd, argv, { stdio });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });

/**
 * Print the install commands for the user to run by hand. Used when the host CLI
 * is absent or too old / `--print-only`, or as recovery after an install failure.
 * The key is NOT here (it's in the config file), so these are safe to show verbatim.
 */
const printCommands = (
  spec: AgentSpec,
  commands: HostCommand[],
  isJson: boolean,
  reason: "print-only" | "no-host-cli" | "install-failed",
): void => {
  if (isJson) return;
  const preamble =
    reason === "no-host-cli"
      ? `${pc.yellow("⚠")} \`${spec.hostCli}\` not found (or too old to install this). ` +
        `Run these yourself:`
      : reason === "install-failed"
        ? `${pc.yellow("⚠")} Install failed. Finish by running these yourself:`
        : `Run these to install the ${spec.label} ${spec.noun}:`;
  process.stderr.write(`\n${preamble}\n\n`);
  for (const cmd of commands) {
    process.stderr.write(`  ${renderCommand(spec.hostCli, cmd.argv)}\n`);
  }
  process.stderr.write("\n");
};

/** Render a host-CLI command line for display / copy-paste. */
export const renderCommand = (hostCli: string, argv: string[]): string =>
  `${hostCli} ${argv.join(" ")}`;
