import { readdir, readFile, stat, writeFile } from "node:fs/promises";
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

/** Harbor's rule for env names whose values it scrubs (`is_sensitive_env_key`). */
const SENSITIVE_KEY = /(KEY|SECRET|TOKEN(?!S)|PASSWORD|CREDENTIAL|AUTH)/i;
const BOOL_VALUES = new Set(["true", "1", "yes", "false", "0", "no"]);
/** A NUL byte this early means the file is not text (Harbor's scrub skips those too). */
const BINARY_SNIFF_BYTES = 8192;
const REDACTED = Buffer.from("[REDACTED]");

/**
 * The values to scrub from a job's files: Harbor's own rule (sensitive names,
 * no flag values) applied to the whole run env. Harbor only scrubs the agent's
 * and verifier's env, so a secret used elsewhere (environment, task.toml) or
 * the run's project key would otherwise go out as written.
 */
export const secretValues = (env: Record<string, string>): string[] =>
  [
    ...new Set(
      Object.entries(env)
        .filter(
          ([key, value]) =>
            SENSITIVE_KEY.test(key) &&
            value.trim() !== "" &&
            !BOOL_VALUES.has(value.trim().toLowerCase()),
        )
        .map(([, value]) => value),
    ),
  ].sort((a, b) => b.length - a.length);

/** `content` with every secret replaced, compared byte for byte (any encoding). */
export const scrub = (content: Buffer, secrets: string[]): Buffer => {
  let result = content;
  for (const secret of secrets) {
    const needle = Buffer.from(secret);
    let at = result.indexOf(needle);
    if (at === -1) continue;
    const parts: Buffer[] = [];
    let from = 0;
    while (at !== -1) {
      parts.push(result.subarray(from, at), REDACTED);
      from = at + needle.length;
      at = result.indexOf(needle, from);
    }
    parts.push(result.subarray(from));
    result = Buffer.concat(parts);
  }
  return result;
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
 * artifacts are left out, files are scrubbed of `secrets` IN PLACE first, and
 * sizes are capped. Symlinks are skipped.
 */
export const packJobDir = async (
  jobDir: string,
  secrets: string[],
): Promise<JobArchive> => {
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
      const scrubbed = await scrubFile(source, secrets);
      total += scrubbed;
      files.push(fileEntry(source, target, scrubbed, "linux"));
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

/** Scrubs a text file in place. Returns its size afterwards. */
const scrubFile = async (file: string, secrets: string[]): Promise<number> => {
  const content = await readFile(file);
  if (
    secrets.length === 0 ||
    content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  ) {
    return content.length;
  }
  const scrubbed = scrub(content, secrets);
  if (scrubbed !== content) await writeFile(file, scrubbed);
  return scrubbed.length;
};
