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
import { discoverTaskSets, EVAL_CONFIG, type RunOverrides } from "./layout";
import { parseTaskSetSelector, prepareRun } from "./prepare";
import {
  type PreparedRun,
  runImageDefs,
  startRemoteRun,
  taskSetRuns,
} from "./remote";
import { type FollowResult, followRunLog } from "./run-log";
import { type EvaluationLink, parseEvaluationLine } from "./run-log-lines";

const logger = initializeLogger();

interface EvalRunOpts extends GlobalOpts {
  dir: string;
  remote?: boolean;
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
  runId: string;
  sandboxId: string;
  evaluations: EvaluationLink[];
  exitCode: number | null;
  result: FollowResult;
}

/** Print a started remote run's log until it ends. */
const followRemote = async (
  client: LaminarClient,
  run: { runId: string; sandboxId: string },
  url: string | undefined,
): Promise<FollowedRun> => {
  logger.info(
    `Started run ${run.runId} in sandbox ${run.sandboxId}; following its ` +
      "log (Ctrl-C stops following, the run goes on).",
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
    ...run,
    evaluations: links,
    exitCode: result.kind === "exited" ? result.exitCode : null,
    result,
  };
};

const runLocal = async (
  prepared: PreparedRun,
  overrides: RunOverrides,
  env: Record<string, string>,
  opts: EvalRunOpts,
) => {
  const runEnv = await harborEnv(env, opts);
  await buildLocalImages(
    await localImageDefs(
      runImageDefs(prepared),
      prepared.taskSets.map((s) => s.tasksDir),
      overrides,
    ),
  );
  const runs = taskSetRuns(prepared);
  const taskSets = runs.map((r) => r.taskSet);
  const failed = await runTaskSets(runs, overrides, runEnv);
  const url = await projectUrl(opts.projectId, "evaluations");
  if (opts.json) {
    outputJson({ mode: "local", taskSets, failed, url });
  } else if (url) {
    logger.info(`Results are in evaluations grouped by task set: ${url}`);
  }
  assertTaskSetsPassed(failed);
};

/** One remote run covers every task set of the command: they share the scripts. */
const runRemote = async (
  client: LaminarClient,
  prepared: PreparedRun,
  overrides: RunOverrides,
  env: Record<string, string>,
  opts: EvalRunOpts,
) => {
  const url = await projectUrl(opts.projectId, "evaluations");
  const run = await startRemoteRun(client, prepared, overrides, env);
  const { result, ...followed } = await followRemote(client, run, url);
  if (opts.json) {
    outputJson({ mode: "remote", run: followed, url });
  } else if (followed.evaluations.length > 0) {
    process.stderr.write(formatLinks(followed.evaluations));
  } else if (url) {
    logger.info(`Results are in evaluations grouped by task set: ${url}`);
  }
  assertRemotePassed(result);
};

/**
 * `lmnr-cli eval run [sets...]`: run task sets with Harbor, locally on Docker
 * (default) or with `--remote` in Laminar sandboxes, following the run's log
 * until it ends. Each set's evaluation keeps the files it used.
 */
export const handleEvalRun = async (
  names: string[],
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before anything slow so a missing variable fails fast.
  const explicitEnv = opts.env ? parseEnvFlags(opts.env) : {};
  const evalsDir = path.resolve(opts.dir);
  const selectors =
    names.length > 0
      ? names.map(parseTaskSetSelector)
      : (await discoverTaskSets(evalsDir)).map((name) => ({ name }));
  if (selectors.length === 0) {
    throw invalidEvalsDir(
      `No task sets in ${evalsDir}: expected <set>/${EVAL_CONFIG}. ` +
        "`lmnr-cli eval pull <set>` fetches one from Laminar.",
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
    const prepared = await prepareRun(client, evalsDir, selectors, scratch);
    const env = await resolveRunEnv(
      prepared.taskSets.map((s) => ({
        setDir: s.setDir,
        tasksDir: s.tasksDir,
      })),
      overrides,
      explicitEnv,
    );
    if (opts.remote) {
      await runRemote(client, prepared, overrides, env, opts);
    } else {
      await runLocal(prepared, overrides, env, opts);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
