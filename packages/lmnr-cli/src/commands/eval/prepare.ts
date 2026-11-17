import path from "node:path";

import type { EvalAgent, LaminarClient } from "@lmnr-ai/client";

import { evalNotFound, invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import {
  assertName,
  assertTaskImages,
  dirExists,
  hasAgentConfig,
  localTaskSets,
  readState,
  taskSetDir,
} from "./layout";
import type { PreparedAgent, VersionRef } from "./remote";
import { downloadBlob, saveAgentVersion, saveTaskSetVersion } from "./store";
import { findAgent, findTaskSetVersion } from "./sync";

const logger = initializeLogger();

/** A `--task-set name[@number]` flag. */
export interface TaskSetSelector {
  name: string;
  number?: number;
}

export const parseTaskSetSelector = (raw: string): TaskSetSelector => {
  const match = /^([^@]+)(?:@(\d+))?$/.exec(raw);
  if (!match) {
    throw invalidEvalsDir(
      `Invalid --task-set "${raw}": expected <name> or <name>@<version>.`,
    );
  }
  assertName("task set", match[1]);
  return {
    name: match[1],
    number: match[2] === undefined ? undefined : Number(match[2]),
  };
};

/**
 * The agent's scripts: the local folder when it has agent.yaml (snapshotted as
 * a version), otherwise Laminar's head, downloaded under `scratch`.
 */
const prepareScripts = async (
  client: LaminarClient,
  name: string,
  localDir: string,
  remote: EvalAgent | undefined,
  scratch: string,
): Promise<{ agent: VersionRef; dir: string }> => {
  if (await hasAgentConfig(localDir)) {
    const version = await saveAgentVersion(client, name, localDir, false);
    return {
      agent: { name, versionId: version.id, hash: version.hash },
      dir: localDir,
    };
  }
  if (!remote?.head) {
    throw evalNotFound(
      `Agent ${name} has no ${path.join(localDir, "agent.yaml")} and no ` +
        "pushed scripts in Laminar.",
    );
  }
  const dir = path.join(scratch, name);
  await downloadBlob(client, remote.head.hash, dir);
  logger.info(
    `Using Laminar's copy of ${name}'s scripts (v${remote.head.number}): ` +
      `there is no ${localDir}.`,
  );
  return {
    agent: { name, versionId: remote.head.id, hash: remote.head.hash },
    dir,
  };
};

/**
 * Resolve one task set of the run: `@number` and sets without a local copy
 * come from Laminar (downloaded under `scratch`); a local copy is used as is
 * and snapshotted.
 */
const prepareTaskSet = async (
  client: LaminarClient,
  agent: string,
  localAgentDir: string,
  selector: TaskSetSelector,
  remote: EvalAgent | undefined,
  scratch: string,
): Promise<(VersionRef & { dir: string }) | null> => {
  const { name, number } = selector;
  const remoteSet = remote?.taskSets.find((s) => s.name === name);
  const localDir = taskSetDir(localAgentDir, name);

  if (number === undefined && (await dirExists(localDir))) {
    await assertTaskImages(localDir);
    const state = await readState(localDir);
    const head = remoteSet?.head;
    if (!head) {
      logger.info(
        `${agent}/${name} has no pushed version yet: ` +
          `\`lmnr-cli eval push ${agent}/${name}\` publishes it.`,
      );
    } else if (state && head.id !== state.versionId) {
      logger.warn(
        `Your copy of ${agent}/${name} is based on v${state.number}, but ` +
          `Laminar has v${head.number}: \`lmnr-cli eval pull ${agent}/${name}\` merges it in.`,
      );
    }
    const { result } = await saveTaskSetVersion(client, agent, name, localDir, {
      push: false,
      base: state?.versionId ?? null,
    });
    if (!("version" in result)) {
      throw new Error(`Laminar rejected a snapshot of ${agent}/${name}`);
    }
    return {
      name,
      versionId: result.version.id,
      hash: result.version.hash,
      dir: localDir,
    };
  }

  const version =
    number !== undefined
      ? await findTaskSetVersion(client, agent, name, number)
      : remoteSet?.head;
  if (!version) {
    logger.warn(`Skipping ${agent}/${name}: it has no pushed version.`);
    return null;
  }
  const dir = taskSetDir(path.join(scratch, "task-sets", agent), name);
  await downloadBlob(client, version.hash, dir);
  return { name, versionId: version.id, hash: version.hash, dir };
};

/**
 * Every agent the run covers with its scripts and task sets, all recorded in
 * Laminar as the versions the run uses. Default task sets: the local ones
 * plus the agent's task sets in Laminar.
 */
export const prepareAgents = async (
  client: LaminarClient,
  evalsDir: string,
  names: string[],
  selectors: TaskSetSelector[],
  scratch: string,
): Promise<PreparedAgent[]> => {
  const remoteAgents = await client.hostedEvals.listAgents();
  const prepared: PreparedAgent[] = [];
  const found = new Set<string>();
  for (const name of names) {
    assertName("agent", name);
    const remote = findAgent(remoteAgents, name);
    const localDir = path.join(evalsDir, name);
    const { agent, dir } = await prepareScripts(
      client,
      name,
      localDir,
      remote,
      scratch,
    );
    const available = new Set([
      ...(await localTaskSets(localDir)),
      ...(remote?.taskSets.map((s) => s.name) ?? []),
    ]);
    const wanted =
      selectors.length > 0
        ? selectors.filter((s) => available.has(s.name))
        : [...available].sort().map((n) => ({ name: n }));
    const taskSets = [];
    for (const selector of wanted) {
      found.add(selector.name);
      const set = await prepareTaskSet(
        client,
        name,
        localDir,
        selector,
        remote,
        scratch,
      );
      if (set) taskSets.push(set);
    }
    if (taskSets.length === 0) {
      logger.warn(`Agent ${name} has no task sets to run.`);
      continue;
    }
    prepared.push({ agent, dir, taskSets });
  }
  const unknown = selectors.filter((s) => !found.has(s.name));
  if (unknown.length > 0) {
    throw evalNotFound(
      `No task set ${unknown.map((s) => s.name).join(", ")} for ` +
        `${names.join(", ")}, locally or in Laminar.`,
    );
  }
  if (prepared.length === 0) {
    throw invalidEvalsDir("Nothing to run: no agent has a task set.");
  }
  return prepared;
};
