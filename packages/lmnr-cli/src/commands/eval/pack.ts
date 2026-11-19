import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { gzipSync } from "node:zlib";

import { type FileSource, packTar } from "modern-tar/fs";

import { SKIPPED_DIRS } from "./datasets";

/**
 * Never uploaded or hashed, besides `SKIPPED_DIRS`: local env files matter
 * most — uploads are readable by eval code in the sandbox, so secrets travel
 * as env vars, never as files.
 */
const isExcludedFile = (name: string) =>
  name.startsWith(".env") || name === ".DS_Store";

/** An archive entry plus the size the index records. */
export interface PackedFile extends FileSource {
  size: number;
  /** `0o755` when the file is executable, else `0o644`. */
  mode: number;
}

export interface WalkResult {
  /** Archive entries, POSIX paths relative to the walked root, sorted. */
  files: PackedFile[];
  skippedSymlinks: string[];
}

/**
 * `0o755` for a file with any exec bit, else `0o644`. Windows has no execute
 * bits, so there shell scripts get them back by extension, Harbor's own rule
 * (`needs_chmod`).
 */
export const fileMode = (
  name: string,
  statMode: number,
  platform: NodeJS.Platform,
): number =>
  (platform === "win32" ? name.endsWith(".sh") : (statMode & 0o111) !== 0)
    ? 0o755
    : 0o644;

/** Fixed ownership, mtime and mode: the upload carries no local user names or times. */
export const fileEntry = (
  source: string,
  target: string,
  size: number,
  mode: number,
): PackedFile => ({
  type: "file",
  source,
  target,
  size,
  mode,
  mtime: new Date(0),
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
});

/**
 * Walk `root` for packing and hashing, minus the upload exclusions: symlinks,
 * `SKIPPED_DIRS`, `.env*` and `.DS_Store`. `exclude` gets each POSIX path
 * relative to `root` (directories too: an excluded one isn't walked).
 */
export const walkFiles = async (
  root: string,
  platform: NodeJS.Platform = process.platform,
  exclude?: (target: string) => boolean,
): Promise<WalkResult> => {
  const files: PackedFile[] = [];
  const skippedSymlinks: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const target = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude?.(target)) continue;
      if (entry.isSymbolicLink()) {
        // Sandboxes extract with Python's `filter="data"`, which rejects links
        // that escape the archive; skipping keeps uploads predictable.
        skippedSymlinks.push(target);
      } else if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(source, target);
      } else if (entry.isFile() && !isExcludedFile(entry.name)) {
        const { size, mode } = await stat(source);
        files.push(
          fileEntry(source, target, size, fileMode(entry.name, mode, platform)),
        );
      }
    }
  };
  await walk(root, "");
  return { files, skippedSymlinks };
};

/** Where one file sits in the archive; see {@link packFiles}. */
export interface IndexedFile {
  path: string;
  size: number;
  /** Byte range of the gzip member holding the file. */
  offset: number;
  length: number;
  /** Where the file's content starts in the decompressed member. */
  dataOffset: number;
}

/** A member takes no more files once it holds this many uncompressed bytes. */
const MEMBER_BYTES = 1024 * 1024;
/** The two zero blocks that end a tar archive. */
const TAR_END_BYTES = 1024;
const padded = (size: number) => Math.ceil(size / 512) * 512;

/**
 * A `.tar.gz` that is a run of gzip members, one per group of files from the
 * same directory (each file whole), plus the index of where each file sits.
 * Readers of `.tar.gz` (the orchestrator's `tar -xzf`) see one archive, while
 * the UI reads a single file by decompressing only its member. Grouping by
 * directory compresses within a few percent of a single gzip stream, whose
 * 32 KiB window gains little from distant files anyway.
 */
export const packFiles = async (
  files: PackedFile[],
): Promise<{ archive: Buffer; index: IndexedFile[] }> => {
  const members: Buffer[] = [];
  const index: IndexedFile[] = [];
  let archiveBytes = 0;
  let dir: string | undefined;
  let tar: Buffer[] = [];
  let tarBytes = 0;
  let pending: Omit<IndexedFile, "offset" | "length">[] = [];

  const endMember = () => {
    if (tar.length === 0) return;
    const member = gzipSync(Buffer.concat(tar));
    for (const file of pending) {
      index.push({ ...file, offset: archiveBytes, length: member.length });
    }
    members.push(member);
    archiveBytes += member.length;
    tar = [];
    tarBytes = 0;
    pending = [];
  };

  for (const { size, ...source } of files) {
    const fileDir = path.posix.dirname(source.target);
    if (fileDir !== dir || tarBytes >= MEMBER_BYTES) endMember();
    dir = fileDir;
    const packed = await buffer(packTar([source]));
    const entry = packed.subarray(0, packed.length - TAR_END_BYTES);
    pending.push({
      path: source.target,
      size,
      // The entry is its header blocks, then the content padded to 512.
      dataOffset: tarBytes + entry.length - padded(size),
    });
    tar.push(entry);
    tarBytes += entry.length;
  }
  endMember();
  members.push(gzipSync(Buffer.alloc(TAR_END_BYTES)));
  return { archive: Buffer.concat(members), index };
};

interface EvalsArchive {
  archive: Buffer;
  index: IndexedFile[];
  fileCount: number;
  skippedSymlinks: string[];
}

/**
 * Pack the evals folder's CONTENTS (datasets at the archive root, no `evals/`
 * prefix — that is where the orchestrator runs from) into a `.tar.gz`, with
 * the index the UI reads single files by. `exclude` leaves paths out (see
 * {@link walkFiles}).
 */
export const packEvalsDir = async (
  dir: string,
  platform: NodeJS.Platform = process.platform,
  exclude?: (target: string) => boolean,
): Promise<EvalsArchive> => {
  const { files, skippedSymlinks } = await walkFiles(
    path.resolve(dir),
    platform,
    exclude,
  );
  const { archive, index } = await packFiles(files);
  return { archive, index, fileCount: files.length, skippedSymlinks };
};
