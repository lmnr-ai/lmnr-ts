import { readFile, stat } from "node:fs/promises";
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
}

/** What a Laminar sandbox is built from (wire shape of `POST /sandboxes`). */
export interface ImageSpec {
  dockerfile: string;
  contextHashes: string[];
}

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
}

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
    defs.push({ name, dockerfile, context });
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
  const { files } = await walkFiles(context, {
    defaultExclusions: false,
    ignore: await dockerIgnore(dockerfile, context),
  });
  const tar = await packFiles(files, false);
  if (tar.length > MAX_CONTEXT_BYTES) {
    throw invalidEvalsDir(
      `Build context ${context} is ${tar.length} bytes, over the 1 GiB ` +
        "limit. Exclude build output and data with a .dockerignore.",
    );
  }
  return { dockerfile: content, tar, hash: md5(tar) };
};

/** Upload a context unless the project already has it. */
const ensureContext = async (
  client: LaminarClient,
  label: string,
  context: BuildContext,
): Promise<ImageSpec> => {
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
 * Make sure Laminar can build every image the suites use: `lmnr.yaml` images
 * and per-task Dockerfiles. Daytona builds and caches them by content, so an
 * unchanged image costs one `contextExists` call.
 */
export const ensureRemoteImages = async (
  client: LaminarClient,
  evalsDir: string,
  suites: string[],
): Promise<Record<string, ImageMap>> => {
  const images: Record<string, ImageSpec> = {};
  for (const def of await loadImageDefs(evalsDir)) {
    images[def.name] = await ensureContext(
      client,
      `image ${def.name}`,
      await packBuildContext(def.dockerfile, def.context),
    );
  }
  const maps: Record<string, ImageMap> = {};
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const dockerfiles: Record<string, ImageSpec> = {};
    for (const envDir of await findTaskDockerfiles(suiteDir)) {
      const key = path.relative(suiteDir, envDir);
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
