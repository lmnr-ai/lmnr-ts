import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { LaminarClient } from "@lmnr-ai/client";
import { unpackTar } from "modern-tar/fs";

import { dockerFailed, invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import type { ImageDef, ImagePusher } from "./images";
import { REMOTE_PLATFORM, readSavedImage, uploadSavedImage } from "./push";
import { runCommand } from "./run-command";

const logger = initializeLogger();

/**
 * Never sent to a build, whatever `.dockerignore` says: images leave the
 * machine for remote runs, and repo history or env files must not go with them.
 */
const ALWAYS_IGNORED = [
  ".git",
  "**/.git",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
];

/** The ignore file `docker build` would use for `def`, if any. */
const ownIgnoreRules = async (def: ImageDef): Promise<string> => {
  for (const file of [
    `${def.dockerfile}.dockerignore`,
    path.join(def.context, ".dockerignore"),
  ]) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null) return text;
  }
  return "";
};

/**
 * A new temp dir holding `Dockerfile` (`content`) next to a Dockerfile-specific
 * ignore file: `rules` plus `ALWAYS_IGNORED`, last so no `!` rule overrides
 * them. The caller removes the dir.
 */
const buildDir = async (content: string, rules: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "lmnr-build-"));
  await writeFile(path.join(dir, "Dockerfile"), content);
  await writeFile(
    path.join(dir, "Dockerfile.dockerignore"),
    [
      ...(rules.trim() ? [rules.trimEnd()] : []),
      "# Added by lmnr-cli",
      ...ALWAYS_IGNORED,
      "",
    ].join("\n"),
  );
  return dir;
};

/**
 * `buildDir` for `def`'s Dockerfile and its own ignore rules. BuildKit reads
 * `<Dockerfile>.dockerignore` instead of the context's `.dockerignore`, so
 * building with `-f <dir>/Dockerfile` from the real context leaves the guarded
 * files out without copying the context. The caller removes the dir.
 */
export const guardedDockerfile = async (def: ImageDef): Promise<string> => {
  const [content, contextStat] = await Promise.all([
    readFile(def.dockerfile, "utf8").catch(() => null),
    stat(def.context).catch(() => null),
  ]);
  if (content === null) {
    throw invalidEvalsDir(`Dockerfile not found: ${def.dockerfile}`);
  }
  if (!contextStat?.isDirectory()) {
    throw invalidEvalsDir(`Build context not found: ${def.context}`);
  }
  return buildDir(content, await ownIgnoreRules(def));
};

/** `docker build` from a `buildDir`, which it removes. */
const buildFrom = async (
  dir: string,
  context: string,
  tag: string,
  args: string[],
  failure: string,
): Promise<void> => {
  try {
    const code = await runCommand("docker", [
      "build",
      ...args,
      "-f",
      path.join(dir, "Dockerfile"),
      "-t",
      tag,
      context,
    ]);
    if (code !== 0) throw dockerFailed(`${failure} (exit ${code}).`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * `docker build` of `def` without `.git` or env files in the context (see
 * `guardedDockerfile`). `args` go before the context, e.g. `--platform`.
 */
const dockerBuild = async (
  def: ImageDef,
  tag: string,
  args: string[] = [],
): Promise<void> =>
  buildFrom(
    await guardedDockerfile(def),
    def.context,
    tag,
    args,
    `docker build of ${def.name} failed`,
  );

/** Build `lmnr.yaml` images locally, tagged with the name tasks reference. */
export const buildLocalImages = async (defs: ImageDef[]): Promise<void> => {
  for (const def of defs) {
    await dockerBuild(def, def.name);
  }
};

/** Local tag for an image pushed for a remote run, one per image. */
const remoteTag = (name: string) =>
  `lmnr-evals-remote:${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

/** `docker save` the image tagged `tag` and push it through the Laminar API. */
const saveAndUpload = async (
  client: LaminarClient,
  tag: string,
  name: string,
): Promise<string> => {
  const work = await mkdtemp(path.join(tmpdir(), "lmnr-image-"));
  try {
    const archive = path.join(work, "image.tar");
    const code = await runCommand("docker", ["save", "-o", archive, tag]);
    if (code !== 0) {
      throw dockerFailed(`docker save of ${name} failed (exit ${code}).`);
    }
    const unpacked = path.join(work, "image");
    await pipeline(createReadStream(archive), unpackTar(unpacked));
    await rm(archive);
    return await uploadSavedImage(client, name, await readSavedImage(unpacked));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

/**
 * Builds or pulls images for Laminar sandboxes with local Docker for
 * `linux/amd64` and pushes them through the Laminar API, uploading only the
 * layers it lacks.
 */
export const imagePusher = (client: LaminarClient): ImagePusher => ({
  build: async (def) => {
    const tag = remoteTag(def.name);
    logger.info(`Building ${def.name} for ${REMOTE_PLATFORM}`);
    await dockerBuild(def, tag, ["--platform", REMOTE_PLATFORM]);
    return saveAndUpload(client, tag, def.name);
  },
  pull: async (ref) => {
    // A `FROM`-only build fetches the linux/amd64 variant and saves like any
    // built image, even when the registry serves a multi-platform index.
    const tag = remoteTag(ref);
    logger.info(`Pulling ${ref} for ${REMOTE_PLATFORM}`);
    const dir = await buildDir(`FROM ${ref}\n`, "");
    await buildFrom(
      dir,
      dir,
      tag,
      ["--platform", REMOTE_PLATFORM],
      `docker pull of ${ref} failed`,
    );
    return saveAndUpload(client, tag, ref);
  },
});
