import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  EvalAgent,
  EvalAgentVersion,
  LaminarClient,
  TaskSetVersion,
} from "@lmnr-ai/client";

import { errorMessage } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { evalNotFound, invalidEvalsDir, mergeConflict } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { emitData, outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { buildEvalClient } from "./client";
import { fileSha256 } from "./digest";
import {
  assertName,
  assertTaskImages,
  dirExists,
  hasAgentConfig,
  ignoreTaskSets,
  loadAgentConfig,
  localTaskSets,
  readState,
  taskSetDir,
  writeState,
} from "./layout";
import { applyMerge, planMerge } from "./merge";
import { walkFiles } from "./pack";
import {
  AGENT_SCRIPTS,
  downloadBlob,
  otherEntryDigests,
  saveTaskSetVersion,
  setDigests,
  taskDigests,
} from "./store";

const logger = initializeLogger();

export interface SyncOpts extends GlobalOpts {
  dir: string;
}

export interface PullOpts extends SyncOpts {
  all?: boolean;
  force?: boolean;
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
    const remote = await setDigests(remoteDir);
    const local = (await dirExists(setDir))
      ? await setDigests(setDir)
      : { tasks: {}, files: {} };
    const state = await readState(setDir);
    const plan = planMerge(
      { ...state?.tasks, ...state?.files },
      { ...local.tasks, ...local.files },
      { ...remote.tasks, ...remote.files },
    );
    if (plan.conflicts.length > 0) {
      throw mergeConflict(
        `Tasks or files changed both locally and in Laminar (${agent}/${taskSet} ` +
          `v${version.number ?? "?"}): ${plan.conflicts.join(", ")}. Move ` +
          "your local copy of each aside, pull, and re-apply your changes.",
      );
    }
    await applyMerge(setDir, remoteDir, plan);
    await writeState(setDir, {
      versionId: version.id,
      number: version.number,
      hash: version.hash,
      tasks: remote.tasks,
      files: remote.files,
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
  await assertTaskImages(setDir);
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
      const digests = taskDigests(tasks);
      await writeState(setDir, {
        versionId: result.version.id,
        number: result.version.number,
        hash: result.version.hash,
        tasks: digests,
        files: await otherEntryDigests(setDir, digests),
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

/** The first symlink on `target`'s path under `root`, relative to `root`. */
const symlinkOnPath = async (
  root: string,
  target: string,
): Promise<string | null> => {
  const parts = target.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    const stats = await lstat(path.join(root, rel)).catch(() => null);
    if (!stats) return null;
    if (stats.isSymbolicLink()) return rel;
  }
  return null;
};

/**
 * Extract `version`'s scripts over `agentDir`. Without `force`, fails (writing
 * nothing) when it would overwrite a local file with different content or a
 * symlink; `force` replaces the link, never what it points to. Local files
 * Laminar's copy doesn't have stay.
 */
export const pullScripts = async (
  client: LaminarClient,
  agentDir: string,
  version: EvalAgentVersion,
  force: boolean,
): Promise<void> =>
  withTempDir("lmnr-pull-", async (remoteDir) => {
    await downloadBlob(client, version.hash, remoteDir);
    const local = new Map(
      (await dirExists(agentDir))
        ? (
            await walkFiles(agentDir, process.platform, AGENT_SCRIPTS)
          ).files.map((f) => [f.target, f.source])
        : [],
    );
    const changed = new Set<string>();
    // `walkFiles` skips symlinks, and `cp` would write through them.
    const links = new Set<string>();
    for (const file of (await walkFiles(remoteDir)).files) {
      const link = await symlinkOnPath(agentDir, file.target);
      if (link) {
        links.add(link);
        changed.add(link);
        continue;
      }
      const source = local.get(file.target);
      if (
        source &&
        (await fileSha256(source)) !== (await fileSha256(file.source))
      ) {
        changed.add(file.target);
      }
    }
    if (changed.size > 0 && !force) {
      throw mergeConflict(
        `Laminar's scripts would overwrite local changes: ${[...changed].join(", ")}. ` +
          "Commit or move them aside, or pass --force.",
      );
    }
    for (const link of links) await rm(path.join(agentDir, link));
    await cp(remoteDir, agentDir, { recursive: true });
  });

/** `lmnr-cli eval pull <agent>[/<task set>][@<version>] [--all]`. */
export const handleEvalPull = async (
  rawTarget: string,
  opts: PullOpts,
): Promise<void> => {
  const target = parseTarget(rawTarget);
  if (opts.all && target.taskSet) {
    throw invalidEvalsDir("--all pulls every task set; drop the /<task set>.");
  }
  const client = await buildEvalClient(opts);
  const agent = findAgent(await client.hostedEvals.listAgents(), target.agent);
  if (!agent) throw evalNotFound(`No agent ${target.agent} in Laminar.`);
  const agentDir = path.resolve(opts.dir, agent.name);

  // <agent> asks for the scripts the last run used; --all only fills them in
  // when the local copy has none, since runs use the repo's scripts.
  let scripts: EvalAgentVersion | null = null;
  if (!target.taskSet && !opts.all) {
    if (!agent.latestScripts) {
      throw evalNotFound(
        `No run of ${agent.name} has recorded its scripts; pull its task ` +
          `sets with ${agent.name} --all or ${agent.name}/<task set>.`,
      );
    }
    scripts = agent.latestScripts;
  } else if (
    opts.all &&
    agent.latestScripts &&
    !(await hasAgentConfig(agentDir))
  ) {
    scripts = agent.latestScripts;
  }
  if (scripts) {
    await pullScripts(client, agentDir, scripts, !!opts.force);
    logger.info(
      `Pulled the scripts ${agent.name}'s last run used ` +
        `(${scripts.lastUsedAt}). Commit ${path.relative(process.cwd(), agentDir) || "."} ` +
        "to your repo: eval run uses the repo's scripts.",
    );
  }

  const results: PullResult[] = [];
  const sets = target.taskSet
    ? agent.taskSets.filter((s) => s.name === target.taskSet)
    : opts.all
      ? agent.taskSets
      : [];
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
    await ignoreTaskSets(agentDir);
    logger.info(
      `Pulled ${agent.name}/${set.name} ${versionLabel(version)}: ` +
        `${result.updated.length} updated, ${result.removed.length} removed`,
    );
  }
  if (opts.json) {
    outputJson({ agent: agent.name, scripts, taskSets: results });
  }
};

/**
 * agent.yaml's pins, for push's hints only: push doesn't use the scripts, so a
 * broken agent.yaml must not block publishing task sets.
 */
const pinsForHints = async (
  agentDir: string,
): Promise<Record<string, number> | null> => {
  if (!(await hasAgentConfig(agentDir))) return {};
  try {
    return (await loadAgentConfig(agentDir)).pins;
  } catch (error) {
    logger.warn(`Skipping pin hints: ${errorMessage(error)}`);
    return null;
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
  if (sets.length === 0) {
    throw invalidEvalsDir(`Nothing to push: ${agentDir} has no task_sets/.`);
  }
  for (const set of sets) {
    assertName("task set", set);
    if (!(await dirExists(taskSetDir(agentDir, set)))) {
      throw invalidEvalsDir(`No task set ${set} in ${agentDir}/task_sets.`);
    }
  }

  const pins = await pinsForHints(agentDir);
  const client = await buildEvalClient(opts);
  const taskSets: { taskSet: string; version: TaskSetVersion }[] = [];
  for (const set of sets) {
    const version = await pushTaskSet(
      client,
      target.agent,
      set,
      taskSetDir(agentDir, set),
    );
    taskSets.push({ taskSet: set, version });
    await ignoreTaskSets(agentDir);
    logger.info(`Pushed ${target.agent}/${set} as ${versionLabel(version)}`);
    if (!pins) continue;
    const pin = pins[set];
    if (pin === undefined) {
      logger.info(
        `Pin it in agent.yaml (task_sets: {${set}: ${version.number}}) so ` +
          "runs and CI use this version.",
      );
    } else if (pin !== version.number) {
      logger.info(
        `agent.yaml pins ${set} to v${pin}; set it to v${version.number} ` +
          "to run this version in CI.",
      );
    }
  }
  if (opts.json) outputJson({ agent: target.agent, taskSets });
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
    for (const set of agent.taskSets) {
      rows.push([agent.name, set.name, versionLabel(set.head)]);
    }
  }
  emitData(renderTable(["Agent", "Task set", "Head"], rows));
};
