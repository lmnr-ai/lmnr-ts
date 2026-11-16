import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { type Exclude, type PackedFile, walkFiles } from "./pack";

export const fileSha256 = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/**
 * The content hash of a set of files (the same files a blob packs): sha256 over
 * `${path}\0${sha256(content)}\n` per file, by POSIX path in JS string order.
 * Modes and mtimes don't count.
 */
export const treeDigest = async (
  files: Pick<PackedFile, "source" | "target">[],
): Promise<string> => {
  const sorted = [...files].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(`${file.target}\0${await fileSha256(file.source)}\n`);
  }
  return hash.digest("hex");
};

/** {@link treeDigest} of a directory, walked like it is packed. */
export const dirDigest = async (
  dir: string,
  exclude?: Exclude,
): Promise<string> =>
  treeDigest((await walkFiles(dir, process.platform, exclude)).files);
