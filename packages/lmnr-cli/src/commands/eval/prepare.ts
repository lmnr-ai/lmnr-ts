import path from "node:path";

import type { EvalAgent, LaminarClient, TaskSetVersion } from "@lmnr-ai/client";

import { evalNotFound, invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import {
  assertName,
  assertTaskImages,
  dirExists,
  hasAgentConfig,
  loadAgentConfig,
  localTaskSets,
  readState,
  taskSetDir,
} from "./layout";
import type { PreparedAgent, VersionRef } from "./remote";
import { downloadBlob, saveAgentVersion, saveTaskSetVersion } from "./store";
import { findAgent, findTaskSetVersion } from "./sync";

const logger = initializeLogger();

/** A `--task-set name[@number|@latest]` flag. */
export interface TaskSetSelector {
  name: string;
  number?: number | "latest";
}

export const parseTaskSetSelector = (raw: string): TaskSetSelector => {
  const match = /^([^@]+)(?:@(\d+|latest))?$/.exec(raw);
  if (!match) {
    throw invalidEvalsDir(
      `Invalid --task-set "${raw}": expected <name>, <name>@<version> or <name>@latest.`,
    );
  }
  assertName("task set", match[1]);
  const [, name, number] = match;
  if (number === undefined) return { name };
  return { name, number: number === "latest" ? "latest" : Number(number) };
};

/** The agent's scripts: the repo's copy, recorded as what this run uses. */
const prepareScripts = async (
  client: LaminarClient,
  name: string,
  localDir: string,
): Promise<VersionRef> => {
  if (!(await hasAgentConfig(localDir))) {
    throw evalNotFound(
      `No ${path.join(localDir, "agent.yaml")}. \`lmnr-cli eval pull ${name}\` ` +
        "fetches the scripts the last run used; commit them to your repo.",
    );
  }
  const version = await saveAgentVersion(client, name, localDir);
  return { name, versionId: version.id, hash: version.hash };
};

/** Run a local task set copy as is, recorded as a snapshot. */
const prepareLocalCopy = async (
  client: LaminarClient,
  agent: string,
  name: string,
  dir: string,
  head: TaskSetVersion | null,
  pin: number | undefined,
): Promise<VersionRef & { dir: string }> => {
  await assertTaskImages(dir);
  const state = await readState(dir);
  if (!head) {
    logger.info(
      `${agent}/${name} has no pushed version yet: ` +
        `\`lmnr-cli eval push ${agent}/${name}\` publishes it.`,
    );
  }
  if (pin !== undefined && state?.number !== pin) {
    logger.warn(
      `Running your copy of ${agent}/${name} (based on ` +
        `${state?.number ? `v${state.number}` : "no pushed version"}), ` +
        `but agent.yaml pins v${pin}.`,
    );
  } else if (
    pin === undefined &&
    head &&
    state &&
    head.id !== state.versionId
  ) {
    logger.warn(
      `Your copy of ${agent}/${name} is based on v${state.number}, but ` +
        `Laminar has v${head.number}: \`lmnr-cli eval pull ${agent}/${name}\` merges it in.`,
    );
  }
  const { result } = await saveTaskSetVersion(client, agent, name, dir, {
    push: false,
    base: state?.versionId ?? null,
  });
  if (!("version" in result)) {
    throw new Error(`Laminar rejected a snapshot of ${agent}/${name}`);
  }
  return { name, versionId: result.version.id, hash: result.version.hash, dir };
};

/**
 * Resolve one task set of the run, first match wins: an explicit `@number` /
 * `@latest`, a local copy (as is), the agent.yaml pin, and, only for a set
 * named with `--task-set`, Laminar's head. Versions from Laminar are
 * downloaded under `scratch`. Null = skip it.
 */
const prepareTaskSet = async (
  client: LaminarClient,
  agent: string,
  localAgentDir: string,
  selector: TaskSetSelector,
  named: boolean,
  pin: number | undefined,
  remote: EvalAgent | undefined,
  scratch: string,
): Promise<(VersionRef & { dir: string }) | null> => {
  const { name, number } = selector;
  const head = remote?.taskSets.find((s) => s.name === name)?.head ?? null;
  const localDir = taskSetDir(localAgentDir, name);

  let version: TaskSetVersion | null;
  if (typeof number === "number") {
    version = await findTaskSetVersion(client, agent, name, number);
  } else if (number === "latest") {
    version = head;
  } else if (await dirExists(localDir)) {
    return prepareLocalCopy(client, agent, name, localDir, head, pin);
  } else if (pin !== undefined) {
    version = await findTaskSetVersion(client, agent, name, pin);
  } else if (named) {
    version = head;
  } else {
    logger.info(
      `Skipping ${agent}/${name}: not pinned in agent.yaml ` +
        `(pin it, or pass --task-set ${name}).`,
    );
    return null;
  }
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
 * Laminar as the versions the run uses. Default task sets: the pinned ones
 * plus local copies; Laminar's other sets run only when named.
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
    const agent = await prepareScripts(client, name, localDir);
    const { pins } = await loadAgentConfig(localDir);
    const defaults = new Set([
      ...Object.keys(pins),
      ...(await localTaskSets(localDir)),
    ]);
    const available = new Set([
      ...defaults,
      ...(remote?.taskSets.map((s) => s.name) ?? []),
    ]);
    const named = selectors.length > 0;
    const wanted = named
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
        named,
        pins[selector.name],
        remote,
        scratch,
      );
      if (set) taskSets.push(set);
    }
    if (taskSets.length === 0) {
      logger.warn(`Agent ${name} has no task sets to run.`);
      continue;
    }
    prepared.push({ agent, dir: localDir, taskSets });
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
