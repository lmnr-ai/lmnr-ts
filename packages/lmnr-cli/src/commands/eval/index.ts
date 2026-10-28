import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { LaminarClient } from "@lmnr-ai/client";
import { InvalidArgumentError } from "commander";
import { type FileSource, packTar } from "modern-tar/fs";

import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { archiveTooLarge, invalidEvalsDir } from "../../errors";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson, printData } from "../../utils/output";

const logger = initializeLogger();

/** The server's cap on the uploaded archive (`MAX_ARCHIVE_BYTES`). */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/** A suite is an archive-root directory holding a Harbor JobConfig. */
const SUITE_CONFIG = "harbor.yaml";

/**
 * Never uploaded: VCS data, dependency/build caches, and local env files. The
 * last matter most — the archive is readable by the eval's code in the
 * sandbox, so secrets go through `--env`, not files.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const isExcludedFile = (name: string) =>
  name === ".env" || name.startsWith(".env.") || name === ".DS_Store";

export interface EvalsArchive {
  archive: Buffer;
  /** Suite directory names found at the root, sorted. */
  suites: string[];
  fileCount: number;
  skippedSymlinks: string[];
}

interface EvalRunOpts extends GlobalOpts {
  dataset?: string[];
  task?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  env?: string[];
}

/** Commander parser for `--n-attempts` / `--n-concurrent` (server: `NonZeroU32`). */
export const parsePositiveInt = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
};

/**
 * Turn repeatable `--env` flags into the run's env map. `KEY=VALUE` is taken
 * as-is; a bare `KEY` is read from the current environment, so secrets stay out
 * of shell history.
 */
export const parseEnvFlags = (
  entries: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const key = eq === -1 ? entry : entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `Invalid --env "${key}": expected KEY=VALUE or KEY (a variable name).`,
      );
    }
    if (eq !== -1) {
      out[key] = entry.slice(eq + 1);
      continue;
    }
    const value = env[key];
    if (value === undefined) {
      throw new Error(
        `--env ${key}: ${key} is not set in the environment. ` +
          `Export it or pass --env ${key}=<value>.`,
      );
    }
    out[key] = value;
  }
  return out;
};

/** Walk `root`, returning archive entries (POSIX paths relative to `root`). */
const collectFiles = async (
  root: string,
): Promise<{ files: FileSource[]; skippedSymlinks: string[] }> => {
  const files: FileSource[] = [];
  const skippedSymlinks: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // The sandbox extracts with Python's `filter="data"`, which rejects
        // links that escape the archive; skipping keeps uploads predictable.
        skippedSymlinks.push(target);
      } else if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(source, target);
        }
      } else if (entry.isFile() && !isExcludedFile(entry.name)) {
        files.push({ type: "file", source, target });
      }
    }
  };
  await walk(root, "");
  return { files, skippedSymlinks };
};

/**
 * Validate an evals folder and pack its CONTENTS (suites at the archive root,
 * no `evals/` prefix — that is where the sandbox looks) into a `.tar.gz`.
 */
export const packEvalsDir = async (dir: string): Promise<EvalsArchive> => {
  const root = path.resolve(dir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw invalidEvalsDir(`Evals folder not found: ${root}`);
  }

  const { files, skippedSymlinks } = await collectFiles(root);
  const suites = files
    .map((f) => f.target.split("/"))
    .filter((parts) => parts.length === 2 && parts[1] === SUITE_CONFIG)
    .map((parts) => parts[0])
    .sort();
  if (suites.length === 0) {
    throw invalidEvalsDir(
      `No suites in ${root}: expected <suite>/${SUITE_CONFIG} directly ` +
        "inside it. Pass the evals folder itself, not its parent or a suite.",
    );
  }

  const gzip = createGzip();
  const [, archive] = await Promise.all([
    pipeline(packTar(files), gzip),
    buffer(gzip),
  ]);
  return { archive, suites, fileCount: files.length, skippedSymlinks };
};

const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const evaluationsUrl = (projectId: string | undefined): string | undefined => {
  if (!projectId) return undefined;
  const frontend =
    process.env.LMNR_FRONTEND_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_FRONTEND_URL;
  return `${frontend}/project/${projectId}/evaluations`;
};

/**
 * `lmnr-cli eval run [dir]`: pack the evals folder, upload it, and start a
 * hosted run. Returns as soon as the sandbox starts; results land in the
 * project as evaluations grouped by suite name.
 */
export const handleEvalRun = async (
  client: LaminarClient,
  dir: string,
  opts: EvalRunOpts,
): Promise<void> => {
  // Parse --env before the (slow) pack so a missing variable fails fast.
  const env = opts.env ? parseEnvFlags(opts.env) : undefined;

  const { archive, suites, fileCount, skippedSymlinks } =
    await packEvalsDir(dir);
  if (skippedSymlinks.length > 0) {
    logger.warn(
      `Skipped ${skippedSymlinks.length} symlink(s): ` +
        skippedSymlinks.slice(0, 5).join(", ") +
        (skippedSymlinks.length > 5 ? ", ..." : ""),
    );
  }
  const unknown = (opts.dataset ?? []).filter((d) => !suites.includes(d));
  if (unknown.length > 0) {
    throw invalidEvalsDir(
      `Unknown --dataset ${unknown.join(", ")}. ` +
        `Suites in ${path.resolve(dir)}: ${suites.join(", ")}`,
    );
  }
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw archiveTooLarge(
      `Packed evals folder is ${formatMiB(archive.length)}, over the ` +
        `${formatMiB(MAX_ARCHIVE_BYTES)} limit. Remove large files (datasets, ` +
        "build output) from the folder.",
    );
  }
  const datasets = opts.dataset?.length ? opts.dataset : suites;

  logger.info(
    `Uploading ${fileCount} files (${formatMiB(archive.length)}), ` +
      `suites: ${suites.join(", ")}`,
  );
  const { uploadId } = await client.hostedEvals.upload(archive);

  const { sandboxId } = await client.hostedEvals.startRun({
    uploadId,
    datasets: opts.dataset,
    tasks: opts.task,
    nAttempts: opts.nAttempts,
    nConcurrent: opts.nConcurrent,
    model: opts.model,
    env,
  });

  // Same resolution as the client: --project-id, else .lmnr/project.json.
  const url = evaluationsUrl(
    opts.projectId || (await readLocalProjectFile())?.projectId,
  );
  if (opts.json) {
    outputJson({ uploadId, sandboxId, datasets, url });
    return;
  }
  logger.info(`Started hosted eval run, suites: ${datasets.join(", ")}`);
  if (url) {
    logger.info(`Results appear as evaluations grouped by suite: ${url}`);
  }
  printData(sandboxId);
};
