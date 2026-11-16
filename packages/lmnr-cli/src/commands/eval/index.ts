import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";

import type { GlobalOpts } from "../../auth/with-client";
import { harborFailed, invalidEvalsDir, remoteRunFailed } from "../../errors";
import { pc } from "../../utils/colors";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { buildEvalClient, projectUrl } from "./client";
import { buildLocalImages } from "./docker";
import { harborEnv, parseEnvFlags, resolveRunEnv } from "./env";
import { assertTaskSetsPassed, runTaskSets } from "./harbor";
import { localImageDefs } from "./images";
import { discoverAgents, loadAgentConfig, type RunOverrides } from "./layout";
import { parseTaskSetSelector, prepareAgents } from "./prepare";
import { type PreparedAgent, startRemoteRun, taskSetRuns } from "./remote";
import { type FollowResult, followRunLog } from "./run-log";
import { type EvaluationLink, parseEvaluationLine } from "./run-log-lines";

const logger = initializeLogger();

interface EvalRunOpts extends GlobalOpts {
  dir: string;
  remote?: boolean;
  taskSet?: string[];
  task?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  env?: string[];
}

/** Commander parser for `--n-attempts` / `--n-concurrent`. */
export const parsePositiveInt = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
};

/** Exit codes `eval orchestrate` ends with that mean "a task set failed". */
const HARBOR_FAILED_EXIT = 18;

/** Turn how a followed remote run ended into this command's outcome. */
export const assertRemotePassed = (result: FollowResult) => {
  if (result.kind === "lost") {
    throw remoteRunFailed(
      `The run's orchestrator sandbox is ${result.state}` +
        (result.reason ? ` (${result.reason})` : "") +
        " and never reported how the run ended.",
    );
  }
  if (result.kind !== "exited" || result.exitCode === 0) return;
  if (result.exitCode === HARBOR_FAILED_EXIT) {
    throw harborFailed(
      "A task set of the remote run failed; see its log above.",
    );
  }
  throw remoteRunFailed(
    `The remote run exited with code ${result.exitCode}; see its log above.`,
  );
};

const formatLink = ({ taskSet, url }: EvaluationLink) =>
  `${pc.bold(`Laminar evaluation for task set ${taskSet}:`)} ${pc.cyan(url)}`;

/** The evaluation links a run printed, once more where they can't scroll away. */
const formatLinks = (links: EvaluationLink[]) =>
  `\n${pc.bold("Results in Laminar:")}\n` +
  links.map(({ taskSet, url }) => `  ${taskSet}: ${pc.cyan(url)}\n`).join("");

interface FollowedRun {
  agent: string;
  runId: string;
  sandboxId: string;
  evaluations: EvaluationLink[];
  exitCode: number | null;
  result: FollowResult;
}

/** Print a started remote run's log until it ends. */
const followRemote = async (
  client: LaminarClient,
  agent: string,
  run: { runId: string; sandboxId: string },
  url: string | undefined,
): Promise<FollowedRun> => {
  logger.info(
    `Started the remote run of ${agent} in sandbox ${run.sandboxId}; ` +
      "following its log (Ctrl-C stops following, the run goes on).",
  );
  // Each task set's evaluation shows up in the log once the run creates it.
  const links: EvaluationLink[] = [];
  const write = (text: string) => {
    const link = parseEvaluationLine(text.trimEnd());
    if (link) links.push(link);
    process.stderr.write(link ? `${formatLink(link)}\n` : text);
  };
  const onInterrupt = () => {
    process.stderr.write("\nStopped following; the run goes on in Laminar.\n");
    if (links.length > 0) process.stderr.write(formatLinks(links));
    else if (url) process.stderr.write(`Results: ${url}\n`);
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  let result: FollowResult;
  try {
    result = await followRunLog(client.hostedEvals, run.runId, run.sandboxId, {
      write,
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  if (result.kind === "unsupported") {
    logger.warn(
      "This Laminar server doesn't keep run logs, so the run can't be " +
        "followed here; it goes on in Laminar.",
    );
  }
  return {
    agent,
    ...run,
    evaluations: links,
    exitCode: result.kind === "exited" ? result.exitCode : null,
    result,
  };
};

const runLocal = async (
  agents: PreparedAgent[],
  overrides: RunOverrides,
  env: Record<string, string>,
  opts: EvalRunOpts,
) => {
  const runEnv = await harborEnv(env, opts);
  const failed: string[] = [];
  const taskSets: string[] = [];
  for (const prepared of agents) {
    const { images } = await loadAgentConfig(prepared.dir);
    await buildLocalImages(
      await localImageDefs(
        images,
        prepared.taskSets.map((s) => s.dir),
        overrides,
      ),
    );
    const runs = await taskSetRuns(prepared);
    taskSets.push(...runs.map((r) => `${r.agent}/${r.taskSet}`));
    failed.push(...(await runTaskSets(runs, overrides, runEnv)));
  }
  const url = await projectUrl(opts.projectId, "evaluations");
  if (opts.json) {
    outputJson({ mode: "local", taskSets, failed, url });
  } else if (url) {
    logger.info(`Results are in evaluations grouped by task set: ${url}`);
  }
  assertTaskSetsPassed(failed);
};

const runRemote = async (
  client: LaminarClient,
  agents: PreparedAgent[],
  overrides: RunOverrides,
  env: Record<string, string>,
  opts: EvalRunOpts,
) => {
  const started: { agent: string; runId: string; sandboxId: string }[] = [];
  for (const prepared of agents) {
    const run = await startRemoteRun(client, prepared, overrides, env);
    started.push({ agent: prepared.agent.name, ...run });
  }
  const url = await projectUrl(opts.projectId, "evaluations");
  const followed: FollowedRun[] = [];
  for (const { agent, ...run } of started) {
    followed.push(await followRemote(client, agent, run, url));
  }
  const links = followed.flatMap((f) => f.evaluations);
  if (opts.json) {
    outputJson({
      mode: "remote",
      runs: followed.map(({ result: _result, ...run }) => run),
      url,
    });
  } else if (links.length > 0) {
    process.stderr.write(formatLinks(links));
  } else if (url) {
    logger.info(`Results are in evaluations grouped by task set: ${url}`);
  }
  for (const run of followed) assertRemotePassed(run.result);
};

/**
 * `lmnr-cli eval run [agents...]`: run agents' task sets with Harbor, locally
 * on Docker (default) or with `--remote` in Laminar sandboxes, following each
 * run's log until it ends. Every run records the versions it used in Laminar.
 */
export const handleEvalRun = async (
  names: string[],
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const explicitEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const selectors = (opts.taskSet ?? []).map(parseTaskSetSelector);
  const evalsDir = path.resolve(opts.dir);
  const agentNames = names.length > 0 ? names : await discoverAgents(evalsDir);
  if (agentNames.length === 0) {
    throw invalidEvalsDir(
      `No agents in ${evalsDir}: expected <agent>/agent.yaml. Name an agent ` +
        "to run Laminar's copy of it.",
    );
  }
  const overrides: RunOverrides = {
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    extraAgentEnv: Object.keys(explicitEnv),
  };

  const client = await buildEvalClient(opts);
  const scratch = await mkdtemp(path.join(tmpdir(), "lmnr-evals-"));
  try {
    const agents = await prepareAgents(
      client,
      evalsDir,
      agentNames,
      selectors,
      scratch,
    );
    const env = await resolveRunEnv(
      agents.map((a) => ({
        agentDir: a.dir,
        setDirs: a.taskSets.map((s) => s.dir),
      })),
      overrides,
      explicitEnv,
    );
    if (opts.remote) {
      await runRemote(client, agents, overrides, env, opts);
    } else {
      await runLocal(agents, overrides, env, opts);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
