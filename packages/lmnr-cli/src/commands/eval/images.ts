import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";
import { findTaskTomls } from "./suites";

/** Optional evals-folder config: the images tasks reference by `docker_image`. */
export const LMNR_EVALS_CONFIG = "lmnr.yaml";

export interface ImageDef {
  /** The `docker_image` tasks use, e.g. `myapp-evals`. */
  name: string;
  dockerfile: string;
  context: string;
}

/**
 * What a Laminar sandbox starts from (wire shape of `POST /sandboxes`): an
 * image pushed by `push.ts`, by manifest digest.
 */
export interface ImageSpec {
  image: string;
}

/** Read by `lmnr_hosted_env.py` from `LMNR_EVAL_IMAGES`. */
export interface ImageMap {
  /** By `docker_image` name. */
  images: Record<string, ImageSpec>;
  /** By task `environment/` dir, relative to the suite dir. */
  dockerfiles: Record<string, ImageSpec>;
}

/** Builds and pushes images for Laminar sandboxes (`push.ts`). */
export interface ImagePusher {
  /** Build `def` with local Docker and push it. Returns the image digest. */
  build: (def: ImageDef, label: string) => Promise<string>;
  /** Push a registry image no task builds, e.g. `python:3.12-slim`. */
  pull: (ref: string) => Promise<string>;
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
 * Copy `def`'s Dockerfile into a new temp dir, next to a Dockerfile-specific
 * ignore file: the image's own rules plus `ALWAYS_IGNORED`, last so no `!`
 * rule overrides them. BuildKit reads `<Dockerfile>.dockerignore` instead of
 * the context's `.dockerignore`, so building with `-f <dir>/Dockerfile` from
 * the real context leaves those files out without copying the context. The
 * caller removes the dir.
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
  const rules = await ownIgnoreRules(def);
  const dir = await mkdtemp(path.join(tmpdir(), "lmnr-build-"));
  await writeFile(path.join(dir, "Dockerfile"), content);
  await writeFile(
    path.join(dir, "Dockerfile.dockerignore"),
    [rules.trimEnd(), "# Added by lmnr-cli", ...ALWAYS_IGNORED, ""].join("\n"),
  );
  return dir;
};

const DOCKER_IMAGE = /^\s*docker_image\s*=\s*["']([^"']+)["']/m;

export interface TaskImages {
  /** Task `environment/` dirs Harbor builds from their own Dockerfile. */
  dockerfiles: string[];
  /** `docker_image`s the tasks use, each once. */
  images: string[];
}

/**
 * What the suite's tasks start from. A task with `docker_image` uses that
 * image even when it also has a Dockerfile, as Harbor does.
 */
export const findTaskImages = async (suiteDir: string): Promise<TaskImages> => {
  const dockerfiles: string[] = [];
  const images = new Set<string>();
  for (const toml of await findTaskTomls(suiteDir)) {
    const image = DOCKER_IMAGE.exec(await readFile(toml, "utf8"))?.[1];
    if (image) {
      images.add(image);
      continue;
    }
    const envDir = path.join(path.dirname(toml), "environment");
    const hasDockerfile = await stat(path.join(envDir, "Dockerfile")).then(
      (s) => s.isFile(),
      () => false,
    );
    if (hasDockerfile) dockerfiles.push(envDir);
  }
  return { dockerfiles, images: [...images] };
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
 * Push every image the suites use, so Laminar sandboxes can start from them:
 * `lmnr.yaml` images and per-task Dockerfiles are built here, other
 * `docker_image`s are pulled. Each is pushed once per run.
 */
export const ensureRemoteImages = async (
  evalsDir: string,
  suites: string[],
  pusher: ImagePusher,
): Promise<Record<string, ImageMap>> => {
  const images: Record<string, ImageSpec> = {};
  for (const def of await loadImageDefs(evalsDir)) {
    images[def.name] = { image: await pusher.build(def, `image ${def.name}`) };
  }
  const maps: Record<string, ImageMap> = {};
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const tasks = await findTaskImages(suiteDir);
    const dockerfiles: Record<string, ImageSpec> = {};
    for (const envDir of tasks.dockerfiles) {
      const key = dockerfileKey(suiteDir, envDir);
      const def = {
        name: `${suite}/${key}`,
        dockerfile: path.join(envDir, "Dockerfile"),
        context: envDir,
      };
      dockerfiles[key] = { image: await pusher.build(def, def.name) };
    }
    for (const ref of tasks.images) {
      images[ref] ??= { image: await pusher.pull(ref) };
    }
    maps[suite] = { images, dockerfiles };
  }
  return maps;
};
