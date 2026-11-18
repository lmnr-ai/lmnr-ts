import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { SKIPPED_DIRS, TASKS_DIR } from "./datasets";
import {
  fileEntry,
  type IndexedFile,
  isExcludedFile,
  normalizedMode,
  type PackedFile,
  packFiles,
} from "./pack";

/** Dataset and task names, as the server validates them. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_DATASET_NAME = 100;
export const MAX_TASK_NAME = 255;
/** The server's cap on one task's archive. */
export const MAX_TASK_ARCHIVE_BYTES = 512 * 1024 * 1024;

export const isValidName = (name: string, max: number) =>
  name.length <= max && NAME.test(name);

/** Task name → task hash (`sha256:<64 hex>`). */
export type TaskHashes = Record<string, string>;

/** A task file, as hashed and packed. */
export interface TaskFile extends PackedFile {
  /** 0o755 or 0o644 (`normalizedMode`). */
  mode: number;
}

/** UTF-8 byte order, as the task hash sorts paths. */
export const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The files of a task dir that are hashed and packed: regular files,
 * recursively, minus `SKIPPED_DIRS`, `.env*` and the other files uploads leave
 * out (`isExcludedFile`), and symlinks. Paths are POSIX, relative to the task
 * dir, in UTF-8 byte order.
 */
export const walkTaskFiles = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TaskFile[]> => {
  const files: TaskFile[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(source, target);
      } else if (entry.isFile() && !isExcludedFile(entry.name)) {
        const { size, mode } = await stat(source);
        const fileMode = normalizedMode(target, mode, platform);
        files.push({
          ...fileEntry(source, target, size, platform, fileMode),
          mode: fileMode,
        });
      }
    }
  };
  await walk(taskDir, "");
  return files.sort((a, b) => byteOrder(a.target, b.target));
};

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

/**
 * The task hash: `sha256:` + sha256 of one `<mode> <content sha256> <path>\n`
 * line per file, in UTF-8 byte order of the path. The server stores it as is.
 */
export const hashTaskFiles = async (files: TaskFile[]): Promise<string> => {
  const lines: string[] = [];
  for (const file of [...files].sort((a, b) => byteOrder(a.target, b.target))) {
    const content = await sha256File(file.source as string);
    lines.push(`${file.mode.toString(8)} ${content} ${file.target}\n`);
  }
  return `sha256:${createHash("sha256").update(lines.join(""), "utf8").digest("hex")}`;
};

export const hashTaskDir = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> => hashTaskFiles(await walkTaskFiles(taskDir, platform));

/** A dataset's `tasks/` folder as it is on disk. */
export interface LocalTasks {
  /** False when `tasks/` doesn't exist. */
  exists: boolean;
  /** Task name → its dir. */
  dirs: Record<string, string>;
  /** Linked entries of `tasks/`: never hashed, pushed or pulled. */
  symlinks: string[];
}

/**
 * The dataset's tasks: every directory directly in `tasks/` except
 * `SKIPPED_DIRS` and hidden ones (no valid task name starts with `.`; `eval
 * pull` stages there). Files there (the sync state, notes) aren't tasks, and
 * linked dirs are skipped like everywhere else in uploads.
 */
export const listTasks = async (datasetDir: string): Promise<LocalTasks> => {
  const root = path.join(datasetDir, TASKS_DIR);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    () => null,
  );
  const dirs: Record<string, string> = {};
  const symlinks: string[] = [];
  for (const entry of entries ?? []) {
    if (entry.isSymbolicLink()) symlinks.push(entry.name);
    else if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !SKIPPED_DIRS.has(entry.name)
    ) {
      dirs[entry.name] = path.join(root, entry.name);
    }
  }
  return { exists: entries !== null, dirs, symlinks: symlinks.sort() };
};

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

/** Hash every task of the dataset, sorted by name. */
export const hashLocalTasks = async (
  local: LocalTasks,
  platform: NodeJS.Platform = process.platform,
): Promise<TaskHashes> => {
  const names = Object.keys(local.dirs).sort(byteOrder);
  const hashes = await mapLimit(names, 8, (name) =>
    hashTaskDir(local.dirs[name], platform),
  );
  return Object.fromEntries(names.map((name, i) => [name, hashes[i]]));
};

/** A task's archive (paths relative to the task dir) and its file index. */
export const packTask = async (
  taskDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ archive: Buffer; index: IndexedFile[] }> =>
  packFiles(await walkTaskFiles(taskDir, platform));
