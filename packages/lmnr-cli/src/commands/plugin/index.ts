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
import { type Credentials, globalLmnrDirectory, safeReadCredentials } from "../../auth/credentials";
import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../../constants";
import { orange, pc } from "../../utils/colors";
import { emitError } from "../../utils/output";
import { listProjects, promptProjectChoice } from "../../utils/projects";
import { firstNonEmpty } from "../../utils/text";
import { handleLogin } from "../login";

// Exit codes (machine-readable; distinct so automation can branch on the mode):
//   4  no_access          — user lacks access to the requested --project-id
//   6  login_failed       — device-flow login failed / no creds after login
//   7  no_project         — no project to select, or (as `project_ambiguous`)
//                            more than one matched in --json mode

//   8  config_write_failed — minted a key but couldn't write the plugin config file
//   9  mint_failed        — POST /api/cli/api-key failed
//   10 list_projects_failed — GET /v1/cli/projects (discovery) failed
//   13 unsupported_agent  — unknown <agent> argument
//   14 install_failed     — a host `plugin` command exited non-zero
const EXIT_NO_ACCESS = 4;
const EXIT_LOGIN_FAILED = 6;
const EXIT_NO_PROJECT = 7;
const EXIT_CONFIG_WRITE_FAILED = 8;
const EXIT_MINT_FAILED = 9;
const EXIT_LIST_PROJECTS_FAILED = 10;
const EXIT_UNSUPPORTED_AGENT = 13;
const EXIT_INSTALL_FAILED = 14;

/**
 * Registry of agents `plugin add <agent>` can wire up, keyed by the CLI argument
 * the user types. Both supported agents use the same shape: a host CLI with a
 * native plugin marketplace (`<cli> plugin marketplace add` + an install verb),
 * and a shared per-agent config file under `~/.config/lmnr/` that carries the
 * project API key. Neither agent has a per-plugin secret store, so the key lives
 * in that file and the plugin's hook reads it. Adding an agent = one entry.
 */
export interface AgentSpec {
  /** Human-facing label (banners, minted-key name). */
  label: string;
  /** Host CLI binary that owns the plugin system (`claude`, `codex`). */
  hostCli: string;
  /** `<cli> plugin marketplace add <ref>` argument (owner/repo or Git URL). */
  marketplaceRef: string;
  /** The install subcommand + trailing flags this host uses (after `plugin`). */
  installArgv: string[];
  /** Per-user config file (under ~/.config/lmnr) the plugin reads the key from. */
  configFile: string;
  /**
   * Host-specific imperative for activating the freshly installed plugin.
   * Claude Code exposes `/reload-plugins` (reloads hooks in-session, no restart);
   * Codex has no in-session reload, so it restarts.
   */
  activationHint: string;
}

const AGENTS: Record<string, AgentSpec> = {
  "claude-code": {
    label: "Claude Code",
    hostCli: "claude",
    marketplaceRef: "lmnr-ai/lmnr-claude-code-plugin",
    installArgv: ["install", "lmnr@lmnr", "--scope", "user"],
    configFile: "claude-code-plugin.json",
    activationHint: "Run `/reload-plugins`",
  },
  codex: {
    label: "Codex",
    hostCli: "codex",
    marketplaceRef: "lmnr-ai/lmnr-codex-plugin",
    installArgv: ["add", "lmnr@lmnr"],
    configFile: "codex-plugin.json",
    activationHint: "Restart Codex",
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
 * `plugin add <agent>`: onboard the Laminar plugin for a coding agent.
 *
 * Flow: log in (device flow) if needed → pick the project that should receive
 * this agent's traces (deliberately NOT the directory-linked app project) →
 * mint a project API key named after the plugin+host → write it to
 * `~/.config/lmnr/<agent>-plugin.json` (where the plugin's hook reads it) →
 * install the plugin natively (`<cli> plugin marketplace add` + install), or
 * print those commands when the host CLI is missing / `--print-only`.
 *
 * Unlike `setup`, this is GLOBAL and directory-independent: it never reads or
 * writes `.lmnr/project.json` or `.env`. The key never passes through the host
 * CLI's argv — it lives only in the per-agent config file (both agents lack a
 * per-plugin secret store), so the install commands carry no secret.
 */
export const handlePluginAdd = async (agent: string, options: PluginAddOptions): Promise<void> => {
  const isJson = options.json === true;
  const spec = AGENTS[agent];
  if (!spec) {
    emitError(
      isJson,
      "unsupported_agent",
      `Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(", ")}.`,
    );
    process.exit(EXIT_UNSUPPORTED_AGENT);
  }

  const frontendUrl = firstNonEmpty(
    options.frontendUrl,
    process.env.LMNR_FRONTEND_URL,
    DEFAULT_FRONTEND_URL,
  );
  const baseUrl = firstNonEmpty(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);

  if (!isJson) {
    process.stderr.write(`\n${orange("Laminar CLI")} ${pc.dim(`v${version}`)}\n`);
    process.stderr.write(pc.dim(`Setting up the Laminar plugin for ${spec.label}.\n\n`));
  }

  // --- 1. Login ------------------------------------------------------------
  let creds = await safeReadCredentials();
  let loginProjectId: string | null = null;
  if (!creds) {
    let login;
    try {
      login = await handleLogin({ frontendUrl, noBrowser: options.browser === false });
    } catch (err) {
      emitError(isJson, "login_failed", errorMessage(err));
      process.exit(EXIT_LOGIN_FAILED);
    }
    loginProjectId = login.projectId;
    creds = await safeReadCredentials();
    if (!creds) {
      emitError(isJson, "login_failed", "credentials missing after login");
      process.exit(EXIT_LOGIN_FAILED);
    }
  }

  const issuer = creds.issuer || frontendUrl;
  if (!isJson) {
    process.stderr.write(`${pc.green("✓")} Logged in as ${creds.userEmail ?? "<unknown>"}\n`);
  }

  // --- 2. Project selection (deliberate — the dedicated coding-agent project) --
  const project = await resolveProject(creds, baseUrl, options, loginProjectId, isJson);
  if (!isJson) {
    process.stderr.write(
      `${pc.green("✓")} Traces will go to project ${project.name || project.id}` +
        (project.workspaceName ? pc.dim(` (${project.workspaceName})`) : "") +
        "\n",
    );
  }

  // --- 3. Mint a plugin-named key ------------------------------------------
  const keyName = `${spec.label} plugin @ ${hostname()}`;
  let key;
  try {
    key = await mintProjectApiKey(issuer, creds.sessionToken, project.id, keyName);
  } catch (err) {
    emitError(isJson, "mint_failed", errorMessage(err));
    process.exit(EXIT_MINT_FAILED);
  }
  if (!isJson) {
    process.stderr.write(`${pc.green("✓")} Minted a project API key named "${pc.bold(keyName)}"\n`);
  }

  // --- 4. Write the per-agent config file the plugin reads -----------------
  let configPath: string;
  try {
    configPath = writeAgentConfig(spec, key.apiKey, baseUrl);
  } catch (err) {
    emitError(isJson, "config_write_failed", errorMessage(err));
    process.exit(EXIT_CONFIG_WRITE_FAILED);
  }
  if (!isJson) {
    process.stderr.write(`${pc.green("✓")} Wrote ${configPath}\n`);
  }

  // --- 5. Install via the host's native plugin system, or print commands ----
  const hostCommands = buildInstallCommands(spec);
  const commands = hostCommands.map((c) => renderCommand(spec.hostCli, c.argv));
  const canRun = !options.printOnly && hostCliHasPlugins(spec.hostCli);

  // Shared by the success summary and the JSON failure path, so a caller always
  // gets the minted key + commands regardless of outcome.
  const makeResult = (didInstall: boolean, error?: string): PluginAddResult => ({
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
        process.stdout.write(JSON.stringify(makeResult(false, "install_failed")) + "\n");
      } else {
        printCommands(spec, hostCommands, false, "install-failed");
        emitError(
          false,
          "install_failed",
          `A \`${spec.hostCli} plugin\` command failed; commands printed above.`,
        );
      }
      process.exit(EXIT_INSTALL_FAILED);
    }
  } else {
    printCommands(spec, hostCommands, isJson, options.printOnly ? "print-only" : "no-host-cli");
  }

  // --- 6. Summary ----------------------------------------------------------
  const result = makeResult(installed);

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (installed) {
    process.stdout.write(
      `\n${pc.green("✓")} ${spec.label} plugin installed.\n\n` +
        `Next steps:\n` +
        `  1. ${pc.bold(spec.activationHint)} to activate the plugin.\n` +
        `  2. Use ${spec.label} as usual — each turn becomes a Laminar trace.\n`,
    );
  } else {
    process.stdout.write(
      `\nRun the commands above to finish, then activate the plugin ` +
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
    emitError(isJson, "list_projects_failed", errorMessage(err));
    process.exit(EXIT_LIST_PROJECTS_FAILED);
  }

  if (options.projectId) {
    const match = projects.find((p) => p.id === options.projectId);
    if (!match) {
      emitError(
        isJson,
        "no_access",
        `You don't have access to project ${options.projectId}. Accessible: ` +
          projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
      );
      process.exit(EXIT_NO_ACCESS);
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
    emitError(
      isJson,
      "no_project",
      `No projects found. Create one in the dashboard, then re-run \`lmnr-cli plugin add\`.`,
    );
    process.exit(EXIT_NO_PROJECT);
  }
  if (projects.length === 1) {
    return projects[0];
  }
  if (isJson) {
    emitError(
      isJson,
      "project_ambiguous",
      `Multiple projects: pass --project-id <id>. ` +
        projects.map((p) => `${p.id} (${p.workspaceName}/${p.name})`).join(", "),
    );
    process.exit(EXIT_NO_PROJECT);
  }
  return promptProjectChoice(
    projects,
    "\nPick the project to send this agent's traces to " +
      pc.dim("(a dedicated project keeps agent traces separate from your app traces)") +
      ":\n",
  );
};

// ---------------------------------------------------------------------------
// Per-agent config file
// ---------------------------------------------------------------------------

/**
 * Write the per-agent Laminar plugin config (`~/.config/lmnr/<agent>-plugin.json`,
 * mode 0600). This is the sole delivery channel for the project API key: both
 * plugins read it from here (neither agent has a per-plugin secret store), so
 * the key never has to pass through the host CLI's argv. Returns the path.
 */
export const writeAgentConfig = (spec: AgentSpec, apiKey: string, baseUrl: string): string => {
  const dir = globalLmnrDirectory();
  // recursive == `mkdir -p` (no error if it exists). 0700 not 0600: a dir needs the
  // execute bit to traverse into it; the key file itself is written 0600 below.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, spec.configFile);
  const body = JSON.stringify({ projectApiKey: apiKey, baseUrl }, null, 2) + "\n";
  writeFileSync(filePath, body, { mode: 0o600 });
  // `mode` only applies on create; chmod so a re-run can't leave an existing file looser.
  chmodSync(filePath, 0o600);
  return filePath;
};

// ---------------------------------------------------------------------------
// Host-CLI native install
// ---------------------------------------------------------------------------

interface HostCommand {
  label: string;
  argv: string[];
  /** true for steps whose non-zero exit is benign (e.g. marketplace already added). */
  lenient: boolean;
}

export const buildInstallCommands = (spec: AgentSpec): HostCommand[] => [
  {
    label: "Add the Laminar marketplace",
    argv: ["plugin", "marketplace", "add", spec.marketplaceRef],
    lenient: true,
  },
  {
    label: "Install the plugin",
    argv: ["plugin", ...spec.installArgv],
    lenient: false,
  },
];

/**
 * Probe whether the host CLI is present AND exposes a `plugin` subcommand. A
 * single `plugin --help` call covers both: a missing binary throws / non-zero,
 * and a too-old CLI without plugins won't succeed. Cheaper and more robust than
 * parsing a version string.
 */
export const hostCliHasPlugins = (hostCli: string): boolean => {
  try {
    const r = spawn.sync(hostCli, ["plugin", "--help"], { encoding: "utf-8" });
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
      process.stderr.write(`${pc.dim(`$ ${renderCommand(spec.hostCli, cmd.argv)}`)}\n`);
    }
    const code = await runChild(spec.hostCli, cmd.argv, isJson);
    if (code !== 0) {
      if (cmd.lenient) {
        if (!isJson) {
          process.stderr.write(
            `${pc.yellow("⚠")} "${cmd.label}" exited ${code} ` +
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
const runChild = (cmd: string, argv: string[], isJson: boolean): Promise<number> =>
  new Promise((resolve) => {
    const stdio: StdioOptions = isJson ? ["inherit", 2, "inherit"] : "inherit";
    const child = spawn(cmd, argv, { stdio });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });

/**
 * Print the install commands for the user to run by hand. Used when the host CLI
 * is absent / `--print-only`, or as recovery after an install failure. The key
 * is NOT here (it's in the config file), so these are safe to show verbatim.
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
      ? `${pc.yellow("⚠")} \`${spec.hostCli}\` not found (or has no plugin support). ` +
        `Run these yourself:`
      : reason === "install-failed"
        ? `${pc.yellow("⚠")} Install failed. Finish by running these yourself:`
        : `Run these to install the ${spec.label} plugin:`;
  process.stderr.write(`\n${preamble}\n\n`);
  for (const cmd of commands) {
    process.stderr.write(`  ${renderCommand(spec.hostCli, cmd.argv)}\n`);
  }
  process.stderr.write("\n");
};

/** Render a host-CLI command line for display / copy-paste. */
export const renderCommand = (hostCli: string, argv: string[]): string =>
  `${hostCli} ${argv.join(" ")}`;
