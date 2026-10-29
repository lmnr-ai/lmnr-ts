import { copyFile, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LaminarClient } from "@lmnr-ai/client";
import ignore from "ignore";
import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { md5, packFiles, walkFiles } from "./pack";
import { findTaskTomls } from "./suites";

const logger = initializeLogger();

/** Optional evals-folder config: the images tasks reference by `docker_image`. */
export const LMNR_EVALS_CONFIG = "lmnr.yaml";
/** The server's cap on one uploaded build context. */
export const MAX_CONTEXT_BYTES = 1024 * 1024 * 1024;

export interface ImageDef {
  /** The `docker_image` tasks use, e.g. `myapp-evals`. */
  name: string;
  dockerfile: string;
  context: string;
  /**
   * The only paths (POSIX, relative to `context`) sent to the build. Unset
   * sends the whole context.
   */
  include?: string[];
}

/**
 * What a Laminar sandbox starts from (wire shape of `POST /sandboxes`): an
 * image pushed by `push.ts` (manifest digest), or, for a task's own
 * Dockerfile, the Dockerfile plus an uploaded build context for Laminar to
 * build.
 */
export type ImageSpec =
  | { image: string }
  | { dockerfile: string; contextHashes: string[] };

/** Read by `lmnr_hosted_env.py` from `LMNR_EVAL_IMAGES`. */
export interface ImageMap {
  /** By `docker_image` name. */
  images: Record<string, ImageSpec>;
  /** By task `environment/` dir, relative to the suite dir. */
  dockerfiles: Record<string, ImageSpec>;
}

interface RawImage {
  dockerfile?: unknown;
  context?: unknown;
  include?: unknown;
}

/** `images.<name>.include`: non-empty, every path a relative one inside the context. */
const parseInclude = (raw: unknown, where: string): string[] | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidEvalsDir(
      `${where} must be a non-empty list of paths. Omit it to send the whole context.`,
    );
  }
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw invalidEvalsDir(`${where}: every entry must be a path.`);
    }
    const normalized = path.posix
      .normalize(entry.trim().replace(/\\/g, "/"))
      .replace(/\/+$/, "");
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw invalidEvalsDir(
        `${where}: "${entry}" must be a path inside the build context.`,
      );
    }
    return normalized;
  });
};

export const loadImageDefs = async (evalsDir: string): Promise<ImageDef[]> => {
  const file = path.join(evalsDir, LMNR_EVALS_CONFIG);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return [];
  let parsed: { images?: Record<string, RawImage> } | null;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${String(error)}`);
  }
  const defs: ImageDef[] = [];
  for (const [name, raw] of Object.entries(parsed?.images ?? {})) {
    if (typeof raw?.dockerfile !== "string") {
      throw invalidEvalsDir(`${file}: images.${name}.dockerfile is required.`);
    }
    const dockerfile = path.resolve(evalsDir, raw.dockerfile);
    const context =
      typeof raw.context === "string"
        ? path.resolve(evalsDir, raw.context)
        : path.dirname(dockerfile);
    const include = parseInclude(
      raw.include,
      `${file}: images.${name}.include`,
    );
    defs.push({ name, dockerfile, context, ...(include && { include }) });
  }
  return defs;
};

/**
 * `.dockerignore` rules the way `docker build` reads them, plus `.git` and env
 * files: contexts are stored with the sandbox provider, so local secrets stay
 * out even when `.dockerignore` forgets them.
 */
const dockerIgnore = async (dockerfile: string, context: string) => {
  const rules = ignore().add([".git", ".env", ".env.*"]);
  for (const file of [
    `${dockerfile}.dockerignore`,
    path.join(context, ".dockerignore"),
  ]) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null) {
      rules.add(text);
      break;
    }
  }
  return rules;
};

export interface BuildContext {
  dockerfile: string;
  tar: Buffer;
  hash: string;
}

/**
 * The files a build gets: the context (or only its `include` paths), minus
 * `.dockerignore` matches, `.git`, env files and symlinks.
 */
const contextFiles = async (
  dockerfile: string,
  context: string,
  include?: string[],
) => {
  const { files, skippedSymlinks } = await walkFiles(context, {
    defaultExclusions: false,
    ignore: await dockerIgnore(dockerfile, context),
    include,
  });
  if (skippedSymlinks.length > 0) {
    logger.warn(
      `Skipped symlinks in build context ${context}: ` +
        skippedSymlinks.join(", "),
    );
  }
  return files;
};

/** A task's `environment/` dir as a build context for Laminar to build. */
export const packBuildContext = async (
  dockerfile: string,
  context: string,
): Promise<BuildContext> => {
  const [content, contextStat] = await Promise.all([
    readFile(dockerfile, "utf8").catch(() => null),
    stat(context).catch(() => null),
  ]);
  if (content === null) {
    throw invalidEvalsDir(`Dockerfile not found: ${dockerfile}`);
  }
  if (!contextStat?.isDirectory()) {
    throw invalidEvalsDir(`Build context not found: ${context}`);
  }
  const tar = await packFiles(await contextFiles(dockerfile, context), false);
  if (tar.length > MAX_CONTEXT_BYTES) {
    throw invalidEvalsDir(
      `Build context ${context} is ${tar.length} bytes, over the 1 GiB ` +
        "limit. Exclude build output and data with a .dockerignore.",
    );
  }
  return { dockerfile: content, tar, hash: md5(tar) };
};

/**
 * Copy an image's included files into a new temp dir for `docker build`, so
 * local and remote builds get the same files and `.env*` / `.git` never reach
 * an image. The caller removes the dir.
 */
export const stageBuildContext = async (def: ImageDef): Promise<string> => {
  const files = await contextFiles(def.dockerfile, def.context, def.include);
  const dir = await mkdtemp(path.join(tmpdir(), "lmnr-build-"));
  for (const file of files) {
    const target = path.join(dir, ...file.target.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.source as string, target);
  }
  return dir;
};

/** Upload a context unless the project already has it. */
const ensureContext = async (
  client: LaminarClient,
  label: string,
  context: BuildContext,
): Promise<{ dockerfile: string; contextHashes: string[] }> => {
  if (await client.hostedEvals.contextExists(context.hash)) {
    logger.info(`Build context for ${label} is unchanged`);
  } else {
    logger.info(
      `Uploading build context for ${label} ` +
        `(${(context.tar.length / 1024 / 1024).toFixed(1)} MiB)`,
    );
    await client.hostedEvals.uploadContext(context.hash, context.tar);
  }
  return { dockerfile: context.dockerfile, contextHashes: [context.hash] };
};

const DOCKER_IMAGE_LINE = /^\s*docker_image\s*=/m;

/** Task `environment/` dirs Harbor would build from their own Dockerfile. */
export const findTaskDockerfiles = async (
  suiteDir: string,
): Promise<string[]> => {
  const dirs: string[] = [];
  for (const toml of await findTaskTomls(suiteDir)) {
    const envDir = path.join(path.dirname(toml), "environment");
    const hasDockerfile = await stat(path.join(envDir, "Dockerfile")).then(
      (s) => s.isFile(),
      () => false,
    );
    if (
      hasDockerfile &&
      !DOCKER_IMAGE_LINE.test(await readFile(toml, "utf8"))
    ) {
      dirs.push(envDir);
    }
  }
  return dirs;
};

/**
 * `ImageMap.dockerfiles` key for a task's `environment/` dir: relative to the
 * suite dir, always with `/`. A detached run's map is built on the user's
 * machine (possibly Windows) and looked up in a Linux orchestrator.
 */
export const dockerfileKey = (
  suiteDir: string,
  envDir: string,
  paths: path.PlatformPath = path,
): string => paths.relative(suiteDir, envDir).split(paths.sep).join("/");

/**
 * Make sure Laminar sandboxes can start every image the suites use.
 * `lmnr.yaml` images go through `push` (built with local Docker and pushed,
 * see `push.ts`). Per-task Dockerfiles are built by Daytona from an uploaded
 * context, which it caches only by exact content: any change rebuilds the
 * whole image.
 */
export const ensureRemoteImages = async (
  client: LaminarClient,
  evalsDir: string,
  suites: string[],
  push: (def: ImageDef) => Promise<string>,
): Promise<Record<string, ImageMap>> => {
  const images: Record<string, ImageSpec> = {};
  for (const def of await loadImageDefs(evalsDir)) {
    images[def.name] = { image: await push(def) };
  }
  const maps: Record<string, ImageMap> = {};
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const dockerfiles: Record<string, ImageSpec> = {};
    for (const envDir of await findTaskDockerfiles(suiteDir)) {
      const key = dockerfileKey(suiteDir, envDir);
      dockerfiles[key] = await ensureContext(
        client,
        `${suite}/${key}`,
        await packBuildContext(path.join(envDir, "Dockerfile"), envDir),
      );
    }
    maps[suite] = { images, dockerfiles };
  }
  return maps;
};
