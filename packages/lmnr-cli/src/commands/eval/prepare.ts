import path from "node:path";

import type { LaminarClient, TaskSetVersion } from "@lmnr-ai/client";

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
import type { BlobRef, PreparedAgent } from "./remote";
import {
  AGENT_SCRIPTS,
  downloadBlob,
  ensureBlob,
  gitSha,
  TASK_SET_FILES,
} from "./store";
import { findTaskSetVersion } from "./sync";

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

/** The agent's scripts: the repo's copy, uploaded for the run. */
const prepareScripts = async (
  client: LaminarClient,
  name: string,
  localDir: string,
): Promise<{ agent: BlobRef; gitSha?: string }> => {
  if (!(await hasAgentConfig(localDir))) {
    throw evalNotFound(
      `No ${path.join(localDir, "agent.yaml")}. \`lmnr-cli eval pull ${name}\` ` +
        "fetches the scripts the last run used; commit them to your repo.",
    );
  }
  const hash = await ensureBlob(client, localDir, AGENT_SCRIPTS);
  const sha = await gitSha(localDir);
  return { agent: { name, hash }, ...(sha ? { gitSha: sha } : {}) };
};

/**
 * Run a local task set copy as is: uploaded as a blob, never as a version.
 * The evaluation links to a pushed version only when the content matches one.
 */
const prepareLocalCopy = async (
  client: LaminarClient,
  agent: string,
  name: string,
  dir: string,
  head: TaskSetVersion | null,
  pin: number | undefined,
): Promise<BlobRef & { dir: string }> => {
  await assertTaskImages(dir);
  const state = await readState(dir);
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
  const hash = await ensureBlob(client, dir, TASK_SET_FILES);
  const pushed =
    head?.hash === hash ||
    (head !== null &&
      ((await client.hostedEvals.listTaskSetVersions(name)) ?? []).some(
        (v) => v.hash === hash,
      ));
  if (!pushed) {
    logger.info(
      `${agent}/${name}: running your local copy; it is not a pushed version, ` +
        "so the evaluation won't link to one " +
        `(\`lmnr-cli eval push ${agent}/${name}\` publishes it).`,
    );
  }
  return { name, hash, dir };
};

/**
 * Resolve one task set of the run, first match wins: an explicit `@number` /
 * `@latest`, a local copy (as is), the agent.yaml pin, then Laminar's head
 * (only reached for a set named with `--task-set`). Versions from Laminar are
 * downloaded under `scratch`. Null = skip it.
 */
const prepareTaskSet = async (
  client: LaminarClient,
  agent: string,
  localAgentDir: string,
  selector: TaskSetSelector,
  pin: number | undefined,
  head: TaskSetVersion | null,
  scratch: string,
): Promise<(BlobRef & { dir: string }) | null> => {
  const { name, number } = selector;
  const localDir = taskSetDir(localAgentDir, name);

  let version: TaskSetVersion | null;
  if (typeof number === "number") {
    version = await findTaskSetVersion(client, name, number);
  } else if (number === "latest") {
    version = head;
  } else if (await dirExists(localDir)) {
    return prepareLocalCopy(client, agent, name, localDir, head, pin);
  } else if (pin !== undefined) {
    version = await findTaskSetVersion(client, name, pin);
  } else {
    version = head;
  }
  if (!version) {
    logger.warn(`Skipping ${agent}/${name}: it has no pushed version.`);
    return null;
  }
  const dir = taskSetDir(path.join(scratch, "task-sets", agent), name);
  await downloadBlob(client, version.hash, dir);
  return { name, hash: version.hash, dir };
};

/**
 * Every agent the run covers with its scripts and task sets, uploaded as
 * blobs. Default task sets: the pinned ones plus local copies; other task
 * sets in Laminar run only when named, for a run of one agent.
 */
export const prepareAgents = async (
  client: LaminarClient,
  evalsDir: string,
  names: string[],
  selectors: TaskSetSelector[],
  scratch: string,
): Promise<PreparedAgent[]> => {
  const heads = new Map(
    (await client.hostedEvals.listTaskSets()).map((s) => [s.name, s.head]),
  );
  const prepared: PreparedAgent[] = [];
  const found = new Set<string>();
  for (const name of names) {
    assertName("agent", name);
    const localDir = path.join(evalsDir, name);
    const scripts = await prepareScripts(client, name, localDir);
    const { pins } = await loadAgentConfig(localDir);
    const defaults = new Set([
      ...Object.keys(pins),
      ...(await localTaskSets(localDir)),
    ]);
    // Task set names are project-wide: one only in Laminar is this agent's
    // only when the run covers no other agent.
    const wanted =
      selectors.length > 0
        ? selectors.filter(
            (s) =>
              defaults.has(s.name) || (names.length === 1 && heads.has(s.name)),
          )
        : [...defaults].sort().map((n) => ({ name: n }));
    const taskSets = [];
    for (const selector of wanted) {
      found.add(selector.name);
      const set = await prepareTaskSet(
        client,
        name,
        localDir,
        selector,
        pins[selector.name],
        heads.get(selector.name) ?? null,
        scratch,
      );
      if (set) taskSets.push(set);
    }
    if (taskSets.length === 0) {
      logger.warn(`Agent ${name} has no task sets to run.`);
      continue;
    }
    prepared.push({ ...scripts, dir: localDir, taskSets });
  }
  const unknown = selectors.filter((s) => !found.has(s.name));
  const ambiguous = unknown.filter((s) => heads.has(s.name));
  if (ambiguous.length > 0) {
    const sets = ambiguous.map((s) => s.name).join(", ");
    throw invalidEvalsDir(
      `Task set ${sets} is in Laminar, but none of ${names.join(", ")} pins ` +
        "it or has a local copy, and task set names are project-wide: run " +
        `one agent (\`lmnr-cli eval run <agent> --task-set ${ambiguous[0].name}\`) ` +
        "or pin it in that agent's agent.yaml.",
    );
  }
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
