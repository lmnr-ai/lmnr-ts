import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  EvalAgent,
  EvalAgentVersion,
  LaminarClient,
  TaskSetVersion,
} from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { evalNotFound, invalidEvalsDir, mergeConflict } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { emitData, outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { buildEvalClient } from "./client";
import {
  assertName,
  assertNoTaskBuilds,
  dirExists,
  hasAgentConfig,
  localTaskSets,
  readState,
  taskSetDir,
  writeState,
} from "./layout";
import { applyMerge, planMerge } from "./merge";
import {
  downloadBlob,
  saveAgentVersion,
  saveTaskSetVersion,
  taskDigests,
  taskManifest,
} from "./store";

const logger = initializeLogger();

export interface SyncOpts extends GlobalOpts {
  dir: string;
}

/** `<agent>[/<task set>][@<number>]`. */
export interface Target {
  agent: string;
  taskSet?: string;
  number?: number;
}

export const parseTarget = (raw: string): Target => {
  const match = /^([^/@]+)(?:\/([^/@]+))?(?:@(\d+))?$/.exec(raw);
  if (!match) {
    throw invalidEvalsDir(
      `Invalid target "${raw}": expected <agent>, <agent>/<task set> or <agent>/<task set>@<version>.`,
    );
  }
  const [, agent, taskSet, number] = match;
  assertName("agent", agent);
  if (taskSet !== undefined) assertName("task set", taskSet);
  if (number !== undefined && taskSet === undefined) {
    throw invalidEvalsDir(
      "Only a task set takes a version: <agent>/<task set>@<version>.",
    );
  }
  return {
    agent,
    taskSet,
    number: number === undefined ? undefined : Number(number),
  };
};

export const findAgent = (
  agents: EvalAgent[],
  name: string,
): EvalAgent | undefined => agents.find((a) => a.name === name);

/** The task set version numbered `number` (pushed versions only). */
export const findTaskSetVersion = async (
  client: LaminarClient,
  agent: string,
  taskSet: string,
  number: number,
): Promise<TaskSetVersion> => {
  const versions = await client.hostedEvals.listTaskSetVersions(agent, taskSet);
  const version = versions?.find((v) => v.number === number);
  if (!version) {
    throw evalNotFound(
      `Task set ${agent}/${taskSet} has no version ${number}.`,
    );
  }
  return version;
};

export const withTempDir = async <T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface PullResult {
  taskSet: string;
  version: number | null;
  updated: string[];
  removed: string[];
}

/**
 * Merge `version` into the local copy at `setDir` task by task (see
 * `planMerge`), then record it as the copy's base. Fails, changing nothing, on
 * a task both sides changed.
 */
export const pullTaskSet = async (
  client: LaminarClient,
  agent: string,
  taskSet: string,
  setDir: string,
  version: TaskSetVersion,
): Promise<PullResult> =>
  withTempDir("lmnr-pull-", async (remoteDir) => {
    await downloadBlob(client, version.hash, remoteDir);
    const remote = taskDigests(await taskManifest(remoteDir));
    const local = (await dirExists(setDir))
      ? taskDigests(await taskManifest(setDir))
      : {};
    const base = (await readState(setDir))?.tasks ?? {};
    const plan = planMerge(base, local, remote);
    if (plan.conflicts.length > 0) {
      throw mergeConflict(
        `Tasks changed both locally and in Laminar (${agent}/${taskSet} ` +
          `v${version.number ?? "?"}): ${plan.conflicts.join(", ")}. Move ` +
          "your local copy of each aside, pull, and re-apply your changes.",
      );
    }
    await applyMerge(setDir, remoteDir, plan, remote);
    await writeState(setDir, {
      versionId: version.id,
      number: version.number,
      hash: version.hash,
      tasks: remote,
    });
    return {
      taskSet,
      version: version.number,
      updated: plan.take,
      removed: plan.remove,
    };
  });

/**
 * Publish the local task set at `setDir` as its new head. When the head moved
 * since the copy's base, Laminar's head is merged in first (a conflict fails)
 * and the push is retried once.
 */
export const pushTaskSet = async (
  client: LaminarClient,
  agent: string,
  taskSet: string,
  setDir: string,
): Promise<TaskSetVersion> => {
  await assertNoTaskBuilds(setDir);
  let base = (await readState(setDir))?.versionId ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result, tasks } = await saveTaskSetVersion(
      client,
      agent,
      taskSet,
      setDir,
      { push: true, base },
    );
    if ("version" in result) {
      await writeState(setDir, {
        versionId: result.version.id,
        number: result.version.number,
        hash: result.version.hash,
        tasks: taskDigests(tasks),
      });
      return result.version;
    }
    const head = result.headMoved;
    if (head) {
      logger.info(
        `${agent}/${taskSet} changed in Laminar (now v${head.number}); merging it in`,
      );
      await pullTaskSet(client, agent, taskSet, setDir, head);
    }
    base = head?.id ?? null;
  }
  throw mergeConflict(
    `${agent}/${taskSet} keeps changing in Laminar; pull and push again.`,
  );
};

const versionLabel = (v: { number: number | null } | null) =>
  v ? (v.number === null ? "snapshot" : `v${v.number}`) : "-";

/** `lmnr-cli eval pull <agent>[/<task set>][@<version>]`. */
export const handleEvalPull = async (
  rawTarget: string,
  opts: SyncOpts,
): Promise<void> => {
  const target = parseTarget(rawTarget);
  const client = await buildEvalClient(opts);
  const agent = findAgent(await client.hostedEvals.listAgents(), target.agent);
  if (!agent) throw evalNotFound(`No agent ${target.agent} in Laminar.`);
  const agentDir = path.resolve(opts.dir, agent.name);

  let scripts: EvalAgentVersion | null = null;
  if (!target.taskSet && agent.head) {
    await downloadBlob(client, agent.head.hash, agentDir);
    scripts = agent.head;
    logger.info(`Pulled ${agent.name}'s scripts (${versionLabel(scripts)})`);
  }

  const results: PullResult[] = [];
  const sets = target.taskSet
    ? agent.taskSets.filter((s) => s.name === target.taskSet)
    : agent.taskSets;
  if (target.taskSet && sets.length === 0) {
    throw evalNotFound(
      `No task set ${agent.name}/${target.taskSet} in Laminar.`,
    );
  }
  for (const set of sets) {
    const version =
      target.number !== undefined
        ? await findTaskSetVersion(client, agent.name, set.name, target.number)
        : set.head;
    if (!version) {
      logger.warn(`${agent.name}/${set.name} has no pushed version yet`);
      continue;
    }
    const result = await pullTaskSet(
      client,
      agent.name,
      set.name,
      taskSetDir(agentDir, set.name),
      version,
    );
    results.push(result);
    logger.info(
      `Pulled ${agent.name}/${set.name} ${versionLabel(version)}: ` +
        `${result.updated.length} updated, ${result.removed.length} removed`,
    );
  }
  if (opts.json) {
    outputJson({ agent: agent.name, scripts, taskSets: results });
  }
};

/** `lmnr-cli eval push <agent>[/<task set>]`. */
export const handleEvalPush = async (
  rawTarget: string,
  opts: SyncOpts,
): Promise<void> => {
  const target = parseTarget(rawTarget);
  if (target.number !== undefined) {
    throw invalidEvalsDir("Push publishes a new version; drop the @<version>.");
  }
  const agentDir = path.resolve(opts.dir, target.agent);
  const sets = target.taskSet
    ? [target.taskSet]
    : await localTaskSets(agentDir);
  const pushScripts = !target.taskSet && (await hasAgentConfig(agentDir));
  if (!pushScripts && sets.length === 0) {
    throw invalidEvalsDir(
      `Nothing to push in ${agentDir}: no agent.yaml and no task_sets/.`,
    );
  }
  for (const set of sets) {
    assertName("task set", set);
    if (!(await dirExists(taskSetDir(agentDir, set)))) {
      throw invalidEvalsDir(`No task set ${set} in ${agentDir}/task_sets.`);
    }
  }

  const client = await buildEvalClient(opts);
  let scripts: EvalAgentVersion | null = null;
  if (pushScripts) {
    scripts = await saveAgentVersion(client, target.agent, agentDir, true);
    logger.info(`Pushed ${target.agent}'s scripts as ${versionLabel(scripts)}`);
  }
  const taskSets: { taskSet: string; version: TaskSetVersion }[] = [];
  for (const set of sets) {
    const version = await pushTaskSet(
      client,
      target.agent,
      set,
      taskSetDir(agentDir, set),
    );
    taskSets.push({ taskSet: set, version });
    logger.info(`Pushed ${target.agent}/${set} as ${versionLabel(version)}`);
  }
  if (opts.json) outputJson({ agent: target.agent, scripts, taskSets });
};

/** `lmnr-cli eval list [agent]`. */
export const handleEvalList = async (
  agentName: string | undefined,
  opts: GlobalOpts,
): Promise<void> => {
  const client = await buildEvalClient(opts);
  let agents = await client.hostedEvals.listAgents();
  if (agentName) {
    agents = agents.filter((a) => a.name === agentName);
    if (agents.length === 0)
      throw evalNotFound(`No agent ${agentName} in Laminar.`);
  }
  if (opts.json) {
    outputJson({ agents });
    return;
  }
  const rows: string[][] = [];
  for (const agent of agents) {
    rows.push([agent.name, "(scripts)", versionLabel(agent.head)]);
    for (const set of agent.taskSets) {
      rows.push([agent.name, set.name, versionLabel(set.head)]);
    }
  }
  emitData(renderTable(["Agent", "Task set", "Head"], rows));
};
