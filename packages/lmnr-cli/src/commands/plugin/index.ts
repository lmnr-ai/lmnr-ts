import { spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";

import { type CliProject, LaminarClient } from "@lmnr-ai/client";

import { version } from "../../../package.json";
import { type Credentials, readCredentials } from "../../auth/credentials";
import { envHttpPort, refreshIfNeeded } from "../../auth/resolve";
import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../../constants";
import { orange, pc } from "../../utils/colors";
import { handleLogin } from "../login";

// Exit codes (machine-readable; distinct so automation can branch on the mode):
//   4  no_access          — user lacks access to the requested --project-id
//   6  login_failed       — device-flow login failed / no creds after login
//   7  no_project         — no project to select (create one first)
//   9  mint_failed        — POST /api/cli/api-key failed
//   13 unsupported_agent  — unknown <agent> argument
//   14 install_failed     — a `claude plugin ...` command exited non-zero
const EXIT_NO_ACCESS = 4;
const EXIT_LOGIN_FAILED = 6;
const EXIT_NO_PROJECT = 7;
const EXIT_MINT_FAILED = 9;
const EXIT_UNSUPPORTED_AGENT = 13;
const EXIT_INSTALL_FAILED = 14;

/**
 * Registry of agents `plugin add <agent>` can wire up. Keyed by the CLI argument
 * the user types. Adding a new coding agent (cursor, codex, …) is a matter of
 * appending an entry here plus its install-command shape.
 */
interface AgentSpec {
  /** Human-facing label (banners, key name). */
  label: string;
  /** `claude plugin marketplace add <ref>` argument. */
  marketplaceRef: string;
  /** `claude plugin install <ref>` argument (plugin@marketplace). */
  pluginRef: string;
  /** userConfig key the project API key is delivered under. */
  keyEnvName: string;
  /** The host CLI binary (`claude`) that installs the plugin. */
  hostCli: string;
}

const AGENTS: Record<string, AgentSpec> = {
  "claude-code": {
    label: "Claude Code",
    marketplaceRef: "lmnr-ai/lmnr-claude-code-plugin",
    pluginRef: "laminar@laminar",
    keyEnvName: "LMNR_PROJECT_API_KEY",
    hostCli: "claude",
  },
};

export interface PluginAddOptions {
  projectId?: string;
  printOnly?: boolean;
  json?: boolean;
  noBrowser?: boolean;
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
  /** true when we ran the host-CLI install; false when we only printed commands. */
  installed: boolean;
  /** The `claude plugin ...` commands, as copy-pasteable strings (key shown). */
  commands: string[];
  restartRequired: boolean;
}

/**
 * `plugin add <agent>`: onboard the Laminar plugin for a coding agent.
 *
 * Flow: log in (device flow) if needed → pick the project that should receive
 * this agent's traces (deliberately NOT the directory-linked app project) →
 * mint a project API key named after the plugin+host → install the plugin via
 * the host CLI (`claude plugin ...`), or print those commands when the host CLI
 * is missing / lacks `--config` / `--print-only` was passed.
 *
 * Unlike `setup`, this is a GLOBAL, directory-independent operation: it never
 * reads or writes `.lmnr/project.json` and never writes `.env`. The key lives
 * only in the host CLI's own (keychain-backed) config via `--config`.
 */
export async function handlePluginAdd(agent: string, options: PluginAddOptions): Promise<void> {
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

  const frontendUrl = pick(
    options.frontendUrl,
    process.env.LMNR_FRONTEND_URL,
    DEFAULT_FRONTEND_URL,
  );
  const baseUrl = pick(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);

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
      login = await handleLogin({ frontendUrl, noBrowser: options.noBrowser });
    } catch (err) {
      emitError(isJson, "login_failed", describeError(err));
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
      `${pc.green("✓")} Traces will go to project ${project.name ?? project.id}` +
        (project.workspaceName ? pc.dim(` (${project.workspaceName})`) : "") +
        "\n",
    );
  }

  // --- 3. Mint a plugin-named key ------------------------------------------
  const keyName = `${spec.label} plugin @ ${hostname()}`;
  let key: MintResponse;
  try {
    key = await mintApiKey(issuer, creds.sessionToken, project.id, keyName);
  } catch (err) {
    emitError(isJson, "mint_failed", describeError(err));
    process.exit(EXIT_MINT_FAILED);
  }
  if (!isJson) {
    process.stderr.write(
      `${pc.green("✓")} Minted a project API key named "${pc.bold(keyName)}"\n`,
    );
  }

  // --- 4. Install via the host CLI, or print the commands ------------------
  const commands = buildInstallCommands(spec, key.apiKey);
  const canRun = !options.printOnly && hostCliSupportsConfig(spec.hostCli);

  let installed = false;
  if (canRun) {
    installed = await runInstall(spec, commands, isJson);
    if (!installed) {
      // A hard install failure (not the lenient marketplace-add path). Fall back
      // to printing so the user can finish by hand.
      printCommands(spec, commands, isJson, "install-failed");
      emitError(
        isJson,
        "install_failed",
        `A \`${spec.hostCli} plugin\` command failed; commands printed above.`,
      );
      // Non-fatal-to-JSON: still emit the result below? No — exit with the code
      // so automation sees the failure. The printed commands remain the recovery.
      process.exit(EXIT_INSTALL_FAILED);
    }
  } else {
    printCommands(spec, commands, isJson, options.printOnly ? "print-only" : "no-host-cli");
  }

  // --- 5. Summary ----------------------------------------------------------
  const result: PluginAddResult = {
    agent,
    projectId: project.id,
    projectName: project.name ?? null,
    workspaceName: project.workspaceName ?? null,
    apiKey: key.apiKey,
    apiKeyId: key.apiKeyId ?? null,
    installed,
    commands: commands.map((c) => renderCommand(spec.hostCli, c.argv, false)),
    restartRequired: installed,
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (installed) {
    process.stdout.write(
      `\n${pc.green("✓")} ${spec.label} plugin installed.\n\n` +
        `Next steps:\n` +
        `  1. ${pc.bold(`Restart ${spec.label}`)} to activate the plugin.\n` +
        `  2. Use ${spec.label} as usual — each turn becomes a Laminar trace.\n`,
    );
  } else {
    process.stdout.write(
      `\nRun the commands above to finish, then ${pc.bold(`restart ${spec.label}`)}.\n`,
    );
  }
}

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
async function resolveProject(
  creds: Credentials,
  baseUrl: string,
  options: PluginAddOptions,
  loginProjectId: string | null,
  isJson: boolean,
): Promise<CliProject> {
  const projects = await listProjects(creds, baseUrl);

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
  return promptProjectChoice(projects);
}

/** List the projects the user can access (user-JWT discovery). */
async function listProjects(creds: Credentials, baseUrl: string): Promise<CliProject[]> {
  const updated = await refreshIfNeeded(creds);
  const client = new LaminarClient({
    baseUrl,
    port: envHttpPort(),
    auth: { type: "userToken", token: updated.accessToken, projectId: "" },
  });
  return client.cli.listProjects();
}

async function promptProjectChoice(projects: CliProject[]): Promise<CliProject> {
  process.stderr.write(
    "\nPick the project to send this agent's traces to " +
      pc.dim("(a dedicated project keeps agent traces separate from your app traces)") +
      ":\n",
  );
  projects.forEach((p, i) => {
    process.stderr.write(`  ${i + 1}) ${p.workspaceName} / ${p.name}\n`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (await rl.question(`Select [1-${projects.length}]: `)).trim();
      const idx = Number.parseInt(answer, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) {
        return projects[idx - 1];
      }
      process.stderr.write(`${pc.red("Invalid selection.")}\n`);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Key minting
// ---------------------------------------------------------------------------

interface MintResponse {
  apiKey: string;
  apiKeyId?: string;
  projectId?: string;
  projectName?: string;
  workspaceName?: string;
}

/**
 * POST /api/cli/api-key with the session bearer for an explicit project.
 * `deviceName` is the human-visible name the key shows under in the dashboard —
 * we pass a plugin-evident label so the key is recognizable and revocable.
 */
async function mintApiKey(
  issuer: string,
  sessionToken: string,
  projectId: string,
  deviceName: string,
): Promise<MintResponse> {
  const url = `${trimSlash(issuer)}/api/cli/api-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceName, projectId }),
  });
  if (res.ok) {
    return (await res.json()) as MintResponse;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `api-key request failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Host-CLI (claude) install
// ---------------------------------------------------------------------------

interface HostCommand {
  label: string;
  argv: string[];
  /** true for steps whose non-zero exit is benign (e.g. marketplace already added). */
  lenient: boolean;
}

export function buildInstallCommands(spec: AgentSpec, apiKey: string): HostCommand[] {
  return [
    {
      label: "Add the Laminar marketplace",
      argv: ["plugin", "marketplace", "add", spec.marketplaceRef],
      lenient: true,
    },
    {
      label: "Install the plugin",
      argv: [
        "plugin",
        "install",
        spec.pluginRef,
        "--config",
        `${spec.keyEnvName}=${apiKey}`,
        "--scope",
        "user",
      ],
      lenient: false,
    },
  ];
}

/**
 * Probe whether the host CLI is present AND its `plugin install` supports
 * `--config`. A single `--help` call covers both: a missing binary throws /
 * non-zero, and older versions won't list `--config`. Cheaper and more robust
 * than parsing a version string.
 */
export function hostCliSupportsConfig(hostCli: string): boolean {
  try {
    const r = spawnSync(hostCli, ["plugin", "install", "--help"], { encoding: "utf-8" });
    if (r.error || r.status !== 0) return false;
    return (r.stdout ?? "").includes("--config");
  } catch {
    return false;
  }
}

/**
 * Run the install commands in order, narrating each. The API key is masked in
 * the echoed command line (it's still passed to the child). A lenient step's
 * non-zero exit is warned-and-continued (e.g. marketplace already added);
 * a non-lenient failure returns false.
 */
async function runInstall(
  spec: AgentSpec,
  commands: HostCommand[],
  isJson: boolean,
): Promise<boolean> {
  if (!isJson) process.stderr.write("\n");
  for (const cmd of commands) {
    if (!isJson) {
      process.stderr.write(`${pc.dim(`$ ${renderCommand(spec.hostCli, cmd.argv, true)}`)}\n`);
    }
    const code = await runChild(spec.hostCli, cmd.argv);
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
}

function runChild(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/**
 * Print the install commands for the user to run by hand. Used when the host CLI
 * is absent / too old / `--print-only`, or as recovery after an install failure.
 * The key IS shown here (copy-paste must be complete) — the one place we print it.
 */
function printCommands(
  spec: AgentSpec,
  commands: HostCommand[],
  isJson: boolean,
  reason: "print-only" | "no-host-cli" | "install-failed",
): void {
  if (isJson) return;
  const preamble =
    reason === "no-host-cli"
      ? `${pc.yellow("⚠")} \`${spec.hostCli}\` not found (or too old for --config). ` +
        `Run these yourself:`
      : reason === "install-failed"
        ? `${pc.yellow("⚠")} Install failed. Finish by running these yourself:`
        : `Run these to install the ${spec.label} plugin:`;
  process.stderr.write(`\n${preamble}\n\n`);
  for (const cmd of commands) {
    process.stderr.write(`  ${renderCommand(spec.hostCli, cmd.argv, false)}\n`);
  }
  process.stderr.write("\n");
}

/**
 * Render a host-CLI command line. When `mask`, replace the secret value in a
 * `--config KEY=secret` pair with `***` so it doesn't hit terminal scrollback.
 */
export function renderCommand(hostCli: string, argv: string[], mask: boolean): string {
  const parts = argv.map((arg, i) => {
    if (mask && i > 0 && argv[i - 1] === "--config") {
      const eq = arg.indexOf("=");
      return eq === -1 ? arg : `${arg.slice(0, eq + 1)}***`;
    }
    return arg;
  });
  return `${hostCli} ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadCredentials(): Promise<Credentials | null> {
  try {
    return await readCredentials();
  } catch {
    return null;
  }
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitError(json: boolean, code: string, detail: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: code, detail }) + "\n");
  } else {
    process.stderr.write(`\n${pc.red(`ERROR (${code})`)}: ${detail}\n`);
  }
}
