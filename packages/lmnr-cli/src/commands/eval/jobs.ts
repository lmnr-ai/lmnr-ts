import { readdir, stat } from "node:fs/promises";
import path from "node:path";

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

/**
 * The job Harbor wrote into a fresh `jobs_dir`, named as Harbor names it (a
 * timestamp unless harbor.yaml sets `job_name`). `undefined` when Harbor exited
 * before writing one, e.g. on an invalid config.
 */
export const findJobDir = async (
  jobsDir: string,
): Promise<string | undefined> => {
  const entries = await readdir(jobsDir, { withFileTypes: true }).catch(
    () => [],
  );
  const jobs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const latest = jobs[jobs.length - 1];
  return latest === undefined ? undefined : path.join(jobsDir, latest);
};

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
