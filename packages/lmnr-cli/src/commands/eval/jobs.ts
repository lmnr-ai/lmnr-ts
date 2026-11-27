import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./eval-py";
import {
  fileEntry,
  fileMode,
  type IndexedFile,
  type PackedFile,
  packFiles,
} from "./pack";

/** A file past this is left out of the upload. */
export const MAX_JOB_FILE_BYTES = 50 * 1024 * 1024;
/** Files stop being added once the upload holds this many (uncompressed). */
export const MAX_JOB_BYTES = 256 * 1024 * 1024;

/**
 * Each step's collected copies of a multi-step trial's files: often large,
 * rarely what explains a trial. Left out.
 */
const STEP_ARTIFACTS_DIR = /^[^/]+\/steps\/[^/]+\/artifacts$/;
/**
 * `<trial>/artifacts`: what an `eval.py` runner grades from, so the Files view
 * shows it, but it can be large (copied app state). Packed after every
 * trial's other files, from what the size cap leaves, so it never pushes out
 * a log.
 */
const TRIAL_ARTIFACTS_DIR = /^[^/]+\/artifacts$/;

/** The job dirs in `jobsDir` by name (none when it doesn't exist yet). */
export const jobDirNames = async (jobsDir: string): Promise<Set<string>> => {
  const entries = await readdir(jobsDir, { withFileTypes: true }).catch(
    () => [],
  );
  return new Set(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name),
  );
};

/**
 * The job a local `harbor run` wrote into `jobsDir`, which may hold earlier
 * jobs (`before`): the config's `job_name`, else the newest new dir.
 * `undefined` when Harbor exited before writing one.
 */
export const newJobDir = async (
  jobsDir: string,
  before: Set<string>,
  jobName: unknown,
): Promise<string | undefined> => {
  const now = await jobDirNames(jobsDir);
  if (typeof jobName === "string") {
    return now.has(jobName) ? path.join(jobsDir, jobName) : undefined;
  }
  const added = [...now].filter((name) => !before.has(name)).sort();
  const latest = added[added.length - 1];
  return latest === undefined ? undefined : path.join(jobsDir, latest);
};

/** A trial's exception (Harbor's `ExceptionInfo`). */
interface TrialException {
  type: string;
  message: string;
}

/** How a dataset's trials ended, from each trial's `result.json`. */
export interface TrialOutcomes {
  /** Trials with a `result.json`. */
  total: number;
  /** Trials that raised and got no reward (`trialException`). */
  errored: number;
  /** The first errored trial's exception, trial dirs in name order. */
  firstError?: TrialException;
}

const exceptionOf = (info: unknown): TrialException | undefined =>
  isRecord(info) && typeof info.exception_type === "string"
    ? {
        type: info.exception_type,
        message:
          typeof info.exception_message === "string"
            ? info.exception_message
            : "",
      }
    : undefined;

/**
 * Why a trial (Harbor 0.25.0's `TrialResult`) errored, or `undefined` when it
 * didn't: it raised (`exception_info`, or a step's, as Harbor's
 * `_recorded_exceptions`) and has no reward (`verifier_result.rewards` unset
 * or empty). A trial that raised but was still graded (an agent timeout) is a
 * result, not a broken eval.
 */
export const trialException = (result: unknown): TrialException | undefined => {
  if (!isRecord(result)) return undefined;
  const verifier = result.verifier_result;
  const rewards = isRecord(verifier) ? verifier.rewards : undefined;
  if (isRecord(rewards) && Object.keys(rewards).length > 0) return undefined;
  const steps = Array.isArray(result.step_results) ? result.step_results : [];
  return [
    result.exception_info,
    ...steps.map((s) => (isRecord(s) ? s.exception_info : undefined)),
  ]
    .map(exceptionOf)
    .find((e) => e !== undefined);
};

/**
 * Count the errored trials of a finished job (`<job>/<trial>/result.json`).
 * Trial dirs without a readable `result.json` (unfinished) aren't counted;
 * Harbor deletes a retried attempt's dir, so each trial counts once.
 */
export const readTrialOutcomes = async (
  jobDir: string | undefined,
): Promise<TrialOutcomes> => {
  const outcomes: TrialOutcomes = { total: 0, errored: 0 };
  if (!jobDir) return outcomes;
  const trials = [...(await jobDirNames(jobDir))].sort();
  for (const trial of trials) {
    let result: unknown;
    try {
      result = JSON.parse(
        await readFile(path.join(jobDir, trial, "result.json"), "utf8"),
      );
    } catch {
      continue;
    }
    outcomes.total += 1;
    const error = trialException(result);
    if (!error) continue;
    outcomes.errored += 1;
    outcomes.firstError ??= error;
  }
  return outcomes;
};

interface JobArchive {
  archive: Buffer;
  index: IndexedFile[];
  /** Files left out for size, relative to the job dir. */
  skipped: string[];
}

/**
 * Pack the trial dirs of a finished Harbor job (`<job>/<trial>/...`, paths
 * relative to the job dir) for Laminar's trial log view. Job-level files and
 * steps' artifacts are left out, sizes are capped, and trials' artifacts only
 * get what the cap leaves after every other trial file. Symlinks are skipped. Secrets
 * are as Harbor left them: it scrubs trial dirs itself before `harbor run` exits.
 */
export const packJobDir = async (jobDir: string): Promise<JobArchive> => {
  const files: PackedFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const artifactDirs: [string, string][] = [];

  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (TRIAL_ARTIFACTS_DIR.test(target))
          artifactDirs.push([source, target]);
        else if (!STEP_ARTIFACTS_DIR.test(target)) await walk(source, target);
        continue;
      }
      if (!entry.isFile()) continue;
      const { size, mode } = await stat(source);
      if (size > MAX_JOB_FILE_BYTES || total + size > MAX_JOB_BYTES) {
        skipped.push(target);
        continue;
      }
      total += size;
      files.push(
        fileEntry(source, target, size, fileMode(entry.name, mode, "linux")),
      );
    }
  };

  const trials = await readdir(jobDir, { withFileTypes: true });
  trials.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const trial of trials) {
    // Harbor keeps caches in dot dirs (`.sources`); job-level files aren't shown yet.
    if (trial.isDirectory() && !trial.name.startsWith(".")) {
      await walk(path.join(jobDir, trial.name), trial.name);
    }
  }
  for (const [source, target] of artifactDirs) await walk(source, target);
  // Back in path order, so one directory's files share archive members.
  files.sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  const { archive, index } = await packFiles(files);
  return { archive, index, skipped };
};
