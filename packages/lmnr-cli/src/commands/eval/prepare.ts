import path from "node:path";

import type { LaminarClient, TaskSetVersion } from "@lmnr-ai/client";

import { evalNotFound, invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import type { ImageDef } from "./images";
import {
  assertName,
  assertTaskImages,
  dirExists,
  EVAL_CONFIG,
  type EvalConfig,
  hasEvalConfig,
  loadEvalConfig,
  readState,
  tasksDir,
} from "./layout";
import type { PreparedRun, PreparedTaskSet } from "./remote";
import {
  downloadBlob,
  ensureBlob,
  gitSha,
  scriptsOf,
  TASK_SET_FILES,
} from "./store";
import { findTaskSetVersion } from "./sync";

const logger = initializeLogger();

/** A `<set>[@<number>|@latest]` argument. */
export interface TaskSetSelector {
  name: string;
  number?: number | "latest";
}

export const parseTaskSetSelector = (raw: string): TaskSetSelector => {
  const match = /^([^@]+)(?:@(\d+|latest))?$/.exec(raw);
  if (!match) {
    throw invalidEvalsDir(
      `Invalid task set "${raw}": expected <set>, <set>@<version> or <set>@latest.`,
    );
  }
  assertName("task set", match[1]);
  const [, name, number] = match;
  if (number === undefined) return { name };
  return { name, number: number === "latest" ? "latest" : Number(number) };
};

/** The set's eval.yaml, which every run of it needs: its scripts live in the repo. */
const loadSetConfig = async (
  name: string,
  setDir: string,
): Promise<EvalConfig> => {
  if (!(await hasEvalConfig(setDir))) {
    throw evalNotFound(
      `No ${path.join(setDir, EVAL_CONFIG)}. \`lmnr-cli eval pull ${name}\` ` +
        "fetches the scripts its last run used; commit them to your repo.",
    );
  }
  return loadEvalConfig(setDir);
};

/** Image names are shared by the run's sets: one name, one definition. */
const assertImagesAgree = (
  sets: { name: string; config: EvalConfig }[],
): void => {
  const seen = new Map<string, { set: string; def: ImageDef }>();
  for (const { name, config } of sets) {
    for (const def of config.images) {
      const other = seen.get(def.name);
      if (!other) {
        seen.set(def.name, { set: name, def });
      } else if (
        other.def.dockerfile !== def.dockerfile ||
        other.def.context !== def.context
      ) {
        throw invalidEvalsDir(
          `Image ${def.name} is defined differently by ${other.set}/${EVAL_CONFIG} ` +
            `and ${name}/${EVAL_CONFIG}; image names are shared by the task ` +
            "sets of a run, so rename one.",
        );
      }
    }
  }
};

/**
 * Run a local tasks copy as is: uploaded as a blob, never as a version. The
 * evaluation links to a pushed version only when the content matches one.
 */
const prepareLocalCopy = async (
  client: LaminarClient,
  name: string,
  dir: string,
  head: TaskSetVersion | null,
  pin: number | undefined,
): Promise<string> => {
  await assertTaskImages(dir);
  const state = await readState(dir);
  if (pin !== undefined && state?.number !== pin) {
    logger.warn(
      `Running your copy of ${name} (based on ` +
        `${state ? `v${state.number}` : "no pushed version"}), ` +
        `but its ${EVAL_CONFIG} pins v${pin}.`,
    );
  } else if (
    pin === undefined &&
    head &&
    state &&
    head.id !== state.versionId
  ) {
    logger.warn(
      `Your copy of ${name} is based on v${state.number}, but Laminar has ` +
        `v${head.number}: \`lmnr-cli eval pull ${name}\` merges it in.`,
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
      `${name}: running your local copy; it is not a pushed version, so the ` +
        "evaluation won't link to one " +
        `(\`lmnr-cli eval push ${name}\` publishes it).`,
    );
  }
  return hash;
};

/**
 * Which tasks a set runs, first match wins: an explicit `@number` /
 * `@latest`, the local `tasks/` copy (as is), the eval.yaml pin, then
 * Laminar's head. Versions from Laminar are downloaded under `scratch`.
 */
const prepareTasks = async (
  client: LaminarClient,
  selector: TaskSetSelector,
  setDir: string,
  pin: number | undefined,
  head: TaskSetVersion | null,
  scratch: string,
): Promise<{ hash: string; tasksDir: string }> => {
  const { name, number } = selector;
  const local = tasksDir(setDir);

  let version: TaskSetVersion | null;
  if (typeof number === "number") {
    version = await findTaskSetVersion(client, name, number);
  } else if (number === "latest") {
    if (!head) throw evalNotFound(`Task set ${name} has no pushed version.`);
    version = head;
  } else if (await dirExists(local)) {
    const hash = await prepareLocalCopy(client, name, local, head, pin);
    return { hash, tasksDir: local };
  } else if (pin !== undefined) {
    version = await findTaskSetVersion(client, name, pin);
  } else {
    version = head;
    if (head) {
      logger.warn(
        `${name} isn't pinned: running the latest version, v${head.number}. ` +
          `Set \`version: ${head.number}\` in its ${EVAL_CONFIG} so CI runs a ` +
          "fixed version.",
      );
    }
  }
  if (!version) {
    throw evalNotFound(
      `Task set ${name} has no tasks: no ${local} and no pushed version in ` +
        "Laminar.",
    );
  }
  const dir = path.join(scratch, name);
  await downloadBlob(client, version.hash, dir);
  return { hash: version.hash, tasksDir: dir };
};

/**
 * Everything a run uses, uploaded as blobs: the evals folder's scripts (once)
 * and each task set's tasks. Every set needs its eval.yaml here.
 */
export const prepareRun = async (
  client: LaminarClient,
  evalsDir: string,
  selectors: TaskSetSelector[],
  scratch: string,
): Promise<PreparedRun> => {
  const sets = [];
  for (const selector of selectors) {
    const setDir = path.join(evalsDir, selector.name);
    sets.push({
      selector,
      name: selector.name,
      setDir,
      config: await loadSetConfig(selector.name, setDir),
    });
  }
  assertImagesAgree(sets);

  const scriptsHash = await ensureBlob(
    client,
    evalsDir,
    await scriptsOf(evalsDir),
  );
  const sha = await gitSha(evalsDir);
  const heads = new Map(
    (await client.hostedEvals.listTaskSets()).map((s) => [s.name, s.head]),
  );
  const taskSets: PreparedTaskSet[] = [];
  for (const { selector, name, setDir, config } of sets) {
    const tasks = await prepareTasks(
      client,
      selector,
      setDir,
      config.version,
      heads.get(name) ?? null,
      scratch,
    );
    taskSets.push({ name, setDir, config, ...tasks });
  }
  return {
    evalsDir,
    scriptsHash,
    ...(sha ? { gitSha: sha } : {}),
    taskSets,
  };
};
