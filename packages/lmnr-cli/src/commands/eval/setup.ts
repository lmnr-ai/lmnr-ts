import { join, relative } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";

import { version } from "../../../package.json";
import { failWith, unsupportedAgent } from "../../errors";
import { SKILL_NAME } from "../../skill/laminar-skill";
import {
  copyToClipboard,
  findInstalledAgents,
  isAgentCaller,
  LAUNCHABLE_AGENTS,
  launchAgent,
} from "../../utils/coding-agents";
import { orange, pc } from "../../utils/colors";
import { findInstalledSkillDirs } from "../../utils/install-skill";
import { runSetup } from "../setup";
import { findLaminarSdk } from "./instrumentation";

/**
 * What the user said about Laminar instrumentation. `unknown` is only used
 * when nobody could be asked (an agent called us without `--instrumentation`):
 * the prompt then has the agent check and ask the user itself.
 */
export type Instrumentation = "already" | "add" | "skip" | "unknown";

export const INSTRUMENTATION_CHOICES = ["already", "add", "skip"] as const;

export interface EvalSetupOptions {
  instrumentation?: Exclude<Instrumentation, "unknown">;
  /** A {@link LAUNCHABLE_AGENTS} key: launch this one without asking which. */
  agent?: string;
  /** Print the prompt instead of launching an agent. */
  printPrompt?: boolean;
  /** Copy the printed prompt to the clipboard without asking. */
  copy?: boolean;
  json?: boolean;
  /** Set by commander's `--no-browser`; false suppresses the device-flow open. */
  browser?: boolean;
  frontendUrl?: string;
  baseUrl?: string;
  projectId?: string;
}

const INSTRUMENTATION_LINES: Record<Instrumentation, string> = {
  already:
    "The agent is already instrumented with Laminar. Keep its tracing as it is.",
  add:
    "The agent isn't instrumented with Laminar yet. Instrument it first, " +
    "following the skill, then build the evals.",
  skip:
    "The agent isn't instrumented with Laminar, and the user chose not to " +
    "instrument it. Don't add Laminar tracing to the app; capture each " +
    "trial's trajectory the way the skill describes for uninstrumented apps.",
  unknown:
    "Check whether the agent is instrumented with Laminar. If it isn't, ask " +
    "the user whether to instrument it before building the evals; the skill " +
    "covers both paths.",
};

/**
 * The task handed to the coding agent. Deliberately short: HOW to instrument
 * and build evals lives in the skill (`SKILL.md` routes to the instrumentation
 * and `env-evals.md` references), so it improves without a CLI release. The
 * prompt only carries what the skill can't know: the user's answers.
 */
export const buildEvalSetupPrompt = (
  instrumentation: Instrumentation,
  skillPath: string | null,
): string => {
  const skill = skillPath
    ? `the Laminar skill (\`${skillPath}\`)`
    : "the Laminar skill (install it with `npx lmnr-cli skill add`)";
  return [
    `Use ${skill} to set up environment evals for the AI agent in this repo, ` +
      "so they run with `lmnr-cli eval run`.",
    INSTRUMENTATION_LINES[instrumentation],
    "Laminar is already set up here: `lmnr-cli` is logged in and linked to " +
      "a project, and LMNR_PROJECT_API_KEY is configured.",
  ].join("\n\n");
};

/**
 * `lmnr-cli eval setup`: get a repo ready for `eval run` and hand the work to
 * the user's coding agent.
 *
 * 1. Run the `setup` steps (login, project link, key, skill refresh), quietly:
 *    one status line when nothing needed doing.
 * 2. Ask whether the agent under test is instrumented with Laminar (default
 *    from a manifest scan), and if not, whether to instrument it.
 * 3. Build a short prompt from the answers that points at the skill.
 * 4. Launch an installed coding-agent CLI interactively with that prompt, or
 *    print it (clipboard copy is opt-in).
 *
 * When an agent is the caller (no TTY or an agent env var), or with `--json` /
 * `--print-prompt`, nothing is asked or launched: the prompt goes to stdout
 * for the caller to follow.
 */
export const handleEvalSetup = async (
  options: EvalSetupOptions,
): Promise<void> => {
  const isJson = options.json === true;
  if (options.agent && !LAUNCHABLE_AGENTS[options.agent]) {
    failWith(
      isJson,
      unsupportedAgent(
        `Unknown agent "${options.agent}". Supported: ` +
          `${Object.keys(LAUNCHABLE_AGENTS).join(", ")}.`,
      ),
    );
  }
  const canAsk = !isJson && !isAgentCaller();

  if (!isJson) {
    process.stderr.write(
      `\n${orange("Laminar CLI")} ${pc.dim(`v${version}`)}\n` +
        pc.dim("Setting up environment evals.\n\n"),
    );
  }

  // --- 1. Setup steps ------------------------------------------------------
  const cwd = process.cwd();
  const setup = await runSetup({
    json: isJson,
    quiet: true,
    browser: options.browser,
    frontendUrl: options.frontendUrl,
    baseUrl: options.baseUrl,
    projectId: options.projectId,
  });
  if (!isJson) {
    const project = setup.projectName ?? setup.projectId;
    const workspace = setup.workspaceName
      ? pc.dim(` (${setup.workspaceName})`)
      : "";
    const user = setup.userEmail ? pc.dim(` as ${setup.userEmail}`) : "";
    process.stderr.write(
      `${pc.green("✓")} Laminar ready: ${project}${workspace}${user}\n`,
    );
  }
  const skillPath = await resolveSkillPath(cwd, setup.skillsInstalled);

  let rl: Interface | null = null;
  const ask = (question: string): Promise<string> => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr });
    return rl.question(question);
  };
  const closePrompts = () => {
    rl?.close();
    rl = null;
  };

  try {
    // --- 2. Instrumentation ----------------------------------------------
    let instrumentation: Instrumentation = options.instrumentation ?? "unknown";
    if (!options.instrumentation && canAsk) {
      instrumentation = await askInstrumentation(ask, cwd);
    }

    // --- 3. Prompt ---------------------------------------------------------
    const prompt = buildEvalSetupPrompt(instrumentation, skillPath);

    if (isJson) {
      process.stdout.write(
        JSON.stringify({
          projectId: setup.projectId,
          projectName: setup.projectName,
          workspaceName: setup.workspaceName,
          instrumentation,
          skillPath,
          prompt,
        }) + "\n",
      );
      return;
    }
    if (!canAsk || options.printPrompt) {
      printPrompt(prompt, options.copy === true);
      return;
    }

    // --- 4. Handoff --------------------------------------------------------
    // Shown once, before the agent question, on stdout (it's the data) and
    // unindented so it pastes cleanly if the user ends up copying it.
    process.stderr.write("\nTask for your coding agent:\n\n");
    process.stdout.write(`${prompt}\n\n`);
    const agentKey = await chooseAgent(ask, options.agent);
    if (agentKey) {
      const agent = LAUNCHABLE_AGENTS[agentKey];
      // The agent needs a clean stdin: release it from readline first.
      closePrompts();
      process.stderr.write(pc.dim(`Handing off to ${agent.label}...\n\n`));
      const code = await launchAgent(agent, prompt);
      if (code !== null) return;
      process.stderr.write(
        `${pc.yellow("⚠")} Couldn't start \`${agent.bin}\`. ` +
          "Paste the task above into your coding agent instead.\n",
      );
    } else {
      process.stderr.write(
        "Paste the task above into your coding agent to continue.\n",
      );
    }
    const copy =
      options.copy === true ||
      (await askYesNo(ask, "Copy it to the clipboard?", false));
    if (copy) reportCopy(prompt);
  } finally {
    closePrompts();
  }
};

type Ask = (question: string) => Promise<string>;

const askYesNo = async (
  ask: Ask,
  question: string,
  defaultYes: boolean,
): Promise<boolean> => {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await ask(`${question} ${pc.dim(hint)} `))
      .trim()
      .toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    process.stderr.write(`${pc.red("Please answer y or n.")}\n`);
  }
};

const askInstrumentation = async (
  ask: Ask,
  cwd: string,
): Promise<Instrumentation> => {
  const found = await findLaminarSdk(cwd);
  const hint =
    found.length > 0
      ? pc.dim(
          `\n  Found the Laminar SDK in ${found.slice(0, 3).join(", ")}` +
            (found.length > 3 ? ` and ${found.length - 3} more` : "") +
            ".\n",
        )
      : "";
  process.stderr.write(hint || "\n");
  if (
    await askYesNo(
      ask,
      "Is the agent you want to evaluate instrumented with Laminar?",
      found.length > 0,
    )
  ) {
    return "already";
  }
  process.stderr.write(
    "\n" +
      pc.dim(
        "  Instrumenting adds the Laminar SDK to your agent: the dependency, one\n" +
          "  Laminar.initialize() call at startup, and spans around its main steps.\n" +
          "  Every run, in production and in evals, then becomes a trace with each\n" +
          "  LLM and tool call, its inputs and outputs, cost and latency.\n" +
          "  Evals work without it too: your coding agent rebuilds each trial's\n" +
          "  trajectory from what your app already stores, such as chat history.\n",
      ) +
      "\n",
  );
  return (await askYesNo(ask, "Instrument it with Laminar?", true))
    ? "add"
    : "skip";
};

/**
 * Pick the agent to launch: `--agent` when it's installed; otherwise confirm
 * the only installed one or pick among several. Null = print the prompt.
 */
const chooseAgent = async (
  ask: Ask,
  requested: string | undefined,
): Promise<string | null> => {
  const installed = findInstalledAgents();
  if (requested) {
    if (installed.includes(requested)) return requested;
    const { label, bin } = LAUNCHABLE_AGENTS[requested];
    process.stderr.write(
      `${pc.yellow("⚠")} ${label} (\`${bin}\`) isn't on your PATH.\n`,
    );
    return null;
  }
  if (installed.length === 0) return null;
  if (installed.length === 1) {
    const { label } = LAUNCHABLE_AGENTS[installed[0]];
    return (await askYesNo(ask, `Open ${label} with this task?`, true))
      ? installed[0]
      : null;
  }
  process.stderr.write("Open a coding agent with this task:\n");
  installed.forEach((key, i) => {
    process.stderr.write(`  ${i + 1}) ${LAUNCHABLE_AGENTS[key].label}\n`);
  });
  const none = installed.length + 1;
  process.stderr.write(`  ${none}) None, I'll paste the task myself\n`);
  while (true) {
    const idx = Number.parseInt((await ask(`Select [1-${none}]: `)).trim(), 10);
    if (idx === none) return null;
    if (Number.isInteger(idx) && idx >= 1 && idx < none) {
      return installed[idx - 1];
    }
    process.stderr.write(`${pc.red("Invalid selection.")}\n`);
  }
};

/** Non-interactive output: the bare prompt on stdout, copied only on `--copy`. */
const printPrompt = (prompt: string, copy: boolean): void => {
  process.stdout.write(`${prompt}\n`);
  if (copy) reportCopy(prompt);
};

const reportCopy = (prompt: string): void => {
  process.stderr.write(
    copyToClipboard(prompt)
      ? `${pc.green("✓")} Copied to the clipboard\n`
      : `${pc.yellow("⚠")} No clipboard tool found (pbcopy, clip, wl-copy, xclip or xsel)\n`,
  );
};

/**
 * The installed `SKILL.md` to name in the prompt, relative to `cwd`: the copy
 * setup just wrote, else one left by an earlier install (when this run's
 * refresh was skipped), else null.
 */
const resolveSkillPath = async (
  cwd: string,
  written: string[],
): Promise<string | null> => {
  const fresh = written.find((p) => p.endsWith(join(SKILL_NAME, "SKILL.md")));
  if (fresh) return relative(cwd, fresh);
  const [dir] = await findInstalledSkillDirs(cwd);
  return dir ? join(dir, "skills", SKILL_NAME, "SKILL.md") : null;
};
