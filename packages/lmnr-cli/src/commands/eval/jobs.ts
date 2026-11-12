import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  fileEntry,
  type IndexedFile,
  type PackedFile,
  packFiles,
} from "./pack";

/** A file past this is left out of the upload. */
export const MAX_JOB_FILE_BYTES = 50 * 1024 * 1024;
/** Files stop being added once the upload holds this many (uncompressed). */
export const MAX_JOB_BYTES = 256 * 1024 * 1024;

/**
 * Collected copies of the sandbox's files: often large, rarely what explains
 * a trial. `<trial>/artifacts` and, for multi-step trials, each step's.
 */
const ARTIFACTS_DIR = /^[^/]+\/(steps\/[^/]+\/)?artifacts$/;

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

interface JobArchive {
  archive: Buffer;
  index: IndexedFile[];
  /** Files left out for size, relative to the job dir. */
  skipped: string[];
}

/**
 * Pack the trial dirs of a finished Harbor job (`<job>/<trial>/...`, paths
 * relative to the job dir) for Laminar's trial log view. Job-level files and
 * artifacts are left out and sizes are capped. Symlinks are skipped. Secrets
 * are as Harbor left them: it scrubs trial dirs itself before `harbor run` exits.
 */
export const packJobDir = async (jobDir: string): Promise<JobArchive> => {
  const files: PackedFile[] = [];
  const skipped: string[] = [];
  let total = 0;

  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ARTIFACTS_DIR.test(target)) await walk(source, target);
        continue;
      }
      if (!entry.isFile()) continue;
      const { size } = await stat(source);
      if (size > MAX_JOB_FILE_BYTES || total + size > MAX_JOB_BYTES) {
        skipped.push(target);
        continue;
      }
      total += size;
      files.push(fileEntry(source, target, size, "linux"));
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
  const { archive, index } = await packFiles(files);
  return { archive, index, skipped };
};
