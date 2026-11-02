import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { invalidEvalsDir } from "../../errors";
import { findTaskTomls, loadSuiteConfig, type RunOverrides } from "./suites";

/** Optional evals-folder config: the images tasks reference by `docker_image`. */
const LMNR_EVALS_CONFIG = "lmnr.yaml";

export interface ImageDef {
  /** Shown in logs and errors; for `lmnr.yaml` images, the `docker_image`. */
  name: string;
  dockerfile: string;
  context: string;
}

/** Every image a remote run uses, as pushed manifest digests. */
export interface RemoteImages {
  /** By `docker_image`. */
  images: Record<string, string>;
  /** By suite, then task `environment/` dir key (`dockerfileKey`). */
  dockerfiles: Record<string, Record<string, string>>;
}

/** One suite's images, read by `lmnr_hosted_env.py` from `LMNR_EVAL_IMAGES`. */
export interface SuiteImages {
  images: Record<string, string>;
  dockerfiles: Record<string, string>;
}

/**
 * Builds or pulls images for Laminar sandboxes and pushes them (`docker.ts`).
 * Passed in so `ensureRemoteImages` is tested without Docker.
 */
export interface ImagePusher {
  /** Build `def` with local Docker and push it. Returns the manifest digest. */
  build: (def: ImageDef) => Promise<string>;
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
 * The `lmnr.yaml` images a local run's tasks start from. Harbor builds per-task
 * Dockerfiles and pulls other images itself.
 */
export const localImageDefs = async (
  evalsDir: string,
  suites: string[],
  overrides: RunOverrides,
): Promise<ImageDef[]> => {
  const used = new Set<string>();
  for (const suite of suites) {
    const tasks = await findTaskImages(path.join(evalsDir, suite), overrides);
    for (const image of tasks.images) used.add(image);
  }
  return (await loadImageDefs(evalsDir)).filter((def) => used.has(def.name));
};

const DOCKER_IMAGE = /^\s*docker_image\s*=\s*["']([^"']+)["']/m;

interface TaskImages {
  /** Task `environment/` dirs Harbor builds from their own Dockerfile. */
  dockerfiles: string[];
  /** `docker_image`s the tasks start from, each once. */
  images: string[];
}

/**
 * What the run's tasks in this suite start from (`findTaskTomls`, so `--task`
 * applies), as Harbor decides it
 * (`should_use_prebuilt_docker_image`): a task's `docker_image`, unless the
 * suite sets `environment.force_build` and the task has its own
 * `environment/Dockerfile`, which is otherwise used only without a
 * `docker_image`.
 */
export const findTaskImages = async (
  suiteDir: string,
  overrides: RunOverrides,
): Promise<TaskImages> => {
  const environment = (await loadSuiteConfig(suiteDir)).environment as
    | { force_build?: unknown }
    | undefined;
  const forceBuild = environment?.force_build === true;
  const dockerfiles: string[] = [];
  const images = new Set<string>();
  for (const toml of await findTaskTomls(suiteDir, overrides)) {
    const image = DOCKER_IMAGE.exec(await readFile(toml, "utf8"))?.[1];
    const envDir = path.join(path.dirname(toml), "environment");
    const hasDockerfile = await stat(path.join(envDir, "Dockerfile")).then(
      (s) => s.isFile(),
      () => false,
    );
    if (image && !(forceBuild && hasDockerfile)) images.add(image);
    else if (hasDockerfile) dockerfiles.push(envDir);
  }
  return { dockerfiles, images: [...images] };
};

/**
 * `dockerfiles` key for a task's `environment/` dir: relative to the suite
 * dir, always with `/`. A remote run's map is built on the user's machine
 * (possibly Windows) and looked up in a Linux orchestrator.
 */
export const dockerfileKey = (
  suiteDir: string,
  envDir: string,
  paths: path.PlatformPath = path,
): string => paths.relative(suiteDir, envDir).split(paths.sep).join("/");

/**
 * Push every image the run's tasks use, so Laminar sandboxes can start from
 * them: per-task Dockerfiles and the `lmnr.yaml` images tasks reference are
 * built here, other `docker_image`s are pulled. Each is pushed once per run.
 */
export const ensureRemoteImages = async (
  evalsDir: string,
  suites: string[],
  overrides: RunOverrides,
  pusher: ImagePusher,
): Promise<RemoteImages> => {
  const defs = new Map(
    (await loadImageDefs(evalsDir)).map((def) => [def.name, def]),
  );
  const images = new Map<string, string>();
  const dockerfiles: RemoteImages["dockerfiles"] = {};
  for (const suite of suites) {
    const suiteDir = path.join(evalsDir, suite);
    const tasks = await findTaskImages(suiteDir, overrides);
    for (const ref of tasks.images) {
      if (images.has(ref)) continue;
      const def = defs.get(ref);
      images.set(ref, def ? await pusher.build(def) : await pusher.pull(ref));
    }
    const suiteDockerfiles: Record<string, string> = {};
    for (const envDir of tasks.dockerfiles) {
      const key = dockerfileKey(suiteDir, envDir);
      suiteDockerfiles[key] = await pusher.build({
        name: `${suite}/${key}`,
        dockerfile: path.join(envDir, "Dockerfile"),
        context: envDir,
      });
    }
    dockerfiles[suite] = suiteDockerfiles;
  }
  return { images: Object.fromEntries(images), dockerfiles };
};

/** `LMNR_EVAL_IMAGES` for one suite of a remote run. */
export const suiteImages = (
  remote: RemoteImages,
  suite: string,
): SuiteImages => ({
  images: remote.images,
  dockerfiles: remote.dockerfiles[suite] ?? {},
});
