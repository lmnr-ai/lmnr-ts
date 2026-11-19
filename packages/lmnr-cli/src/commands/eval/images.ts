import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { invalidEvalsDir } from "../../errors";
import {
  DATASET_CONFIG,
  findTaskTomls,
  loadDatasetConfig,
  type RunOverrides,
} from "./datasets";

/** Where images used to be declared; a leftover one only warns. */
export const LEGACY_IMAGES_FILE = "lmnr.yaml";

export interface ImageDef {
  /** Shown in logs and errors; for harbor.yaml images, the `docker_image`. */
  name: string;
  dockerfile: string;
  context: string;
}

/**
 * Every image a remote run uses, as pushed manifest digests, by dataset (each
 * dataset declares its own in its harbor.yaml).
 */
export interface RemoteImages {
  /** By dataset, then `docker_image`. */
  images: Record<string, Record<string, string>>;
  /** By dataset, then task `environment/` dir key (`dockerfileKey`). */
  dockerfiles: Record<string, Record<string, string>>;
}

/** One dataset's images, read by `lmnr_hosted_env.py` from `LMNR_EVAL_IMAGES`. */
export interface DatasetImages {
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

/**
 * The images `<datasetDir>/harbor.yaml` declares under `images` (lmnr-cli's
 * key, not Harbor's: it is dropped from the job config Harbor gets), paths
 * relative to the dataset dir.
 */
export const loadImageDefs = async (
  datasetDir: string,
): Promise<ImageDef[]> => {
  const file = path.join(datasetDir, DATASET_CONFIG);
  const images = (await loadDatasetConfig(datasetDir)).images;
  if (images == null) return [];
  if (typeof images !== "object" || Array.isArray(images)) {
    throw invalidEvalsDir(
      `${file}: images must map each image name to {dockerfile, context}.`,
    );
  }
  const defs: ImageDef[] = [];
  for (const [name, raw] of Object.entries(
    images as Record<string, RawImage | null>,
  )) {
    if (typeof raw?.dockerfile !== "string") {
      throw invalidEvalsDir(`${file}: images.${name}.dockerfile is required.`);
    }
    const dockerfile = path.resolve(datasetDir, raw.dockerfile);
    const context =
      typeof raw.context === "string"
        ? path.resolve(datasetDir, raw.context)
        : path.dirname(dockerfile);
    defs.push({ name, dockerfile, context });
  }
  return defs;
};

/**
 * The harbor.yaml images a local run's tasks start from, each dataset's own.
 * Harbor builds per-task Dockerfiles and pulls other images itself. Local
 * builds are tagged with the image's name, so two datasets of one run can't
 * define a name differently.
 */
export const localImageDefs = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
): Promise<ImageDef[]> => {
  const defs = new Map<string, ImageDef & { dataset: string }>();
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const used = new Set((await findTaskImages(datasetDir, overrides)).images);
    for (const def of await loadImageDefs(datasetDir)) {
      if (!used.has(def.name)) continue;
      const seen = defs.get(def.name);
      if (
        seen &&
        (seen.dockerfile !== def.dockerfile || seen.context !== def.context)
      ) {
        throw invalidEvalsDir(
          `Image ${def.name} is defined differently by the harbor.yaml of ` +
            `${seen.dataset} and ${dataset}; local builds are tagged by ` +
            "name, so run these datasets separately or rename one image.",
        );
      }
      if (!seen) defs.set(def.name, { ...def, dataset });
    }
  }
  return [...defs.values()].map(({ dataset: _dataset, ...def }) => def);
};

const DOCKER_IMAGE = /^\s*docker_image\s*=\s*["']([^"']+)["']/m;

interface TaskImages {
  /** Task `environment/` dirs Harbor builds from their own Dockerfile. */
  dockerfiles: string[];
  /** `docker_image`s the tasks start from, each once. */
  images: string[];
}

/**
 * What the run's tasks in this dataset start from (`findTaskTomls`, so
 * `--task` applies), as Harbor decides it
 * (`should_use_prebuilt_docker_image`): a task's `docker_image`, unless the
 * dataset sets `environment.force_build` and the task has its own
 * `environment/Dockerfile`, which is otherwise used only without a
 * `docker_image`.
 */
export const findTaskImages = async (
  datasetDir: string,
  overrides: RunOverrides,
): Promise<TaskImages> => {
  const environment = (await loadDatasetConfig(datasetDir)).environment as
    | { force_build?: unknown }
    | undefined;
  const forceBuild = environment?.force_build === true;
  const dockerfiles: string[] = [];
  const images = new Set<string>();
  for (const toml of await findTaskTomls(datasetDir, overrides)) {
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
 * `dockerfiles` key for a task's `environment/` dir: relative to the dataset
 * dir, always with `/`. A remote run's map is built on the user's machine
 * (possibly Windows) and looked up in a Linux orchestrator.
 */
export const dockerfileKey = (
  datasetDir: string,
  envDir: string,
  paths: path.PlatformPath = path,
): string => paths.relative(datasetDir, envDir).split(paths.sep).join("/");

/**
 * Push every image the run's tasks use, so Laminar sandboxes can start from
 * them: per-task Dockerfiles and the harbor.yaml images tasks reference (each
 * dataset's own) are built here, other `docker_image`s are pulled. An image
 * is pushed once per run: builds by Dockerfile and context, pulls by ref.
 */
export const ensureRemoteImages = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
  pusher: ImagePusher,
): Promise<RemoteImages> => {
  const built = new Map<string, string>();
  const pulled = new Map<string, string>();
  const build = async (def: ImageDef) => {
    const key = `${def.dockerfile}\0${def.context}`;
    let digest = built.get(key);
    if (digest === undefined) {
      digest = await pusher.build(def);
      built.set(key, digest);
    }
    return digest;
  };
  const pull = async (ref: string) => {
    let digest = pulled.get(ref);
    if (digest === undefined) {
      digest = await pusher.pull(ref);
      pulled.set(ref, digest);
    }
    return digest;
  };

  const result: RemoteImages = { images: {}, dockerfiles: {} };
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const defs = new Map(
      (await loadImageDefs(datasetDir)).map((def) => [def.name, def]),
    );
    const tasks = await findTaskImages(datasetDir, overrides);
    const images: Record<string, string> = {};
    for (const ref of tasks.images) {
      const def = defs.get(ref);
      images[ref] = def ? await build(def) : await pull(ref);
    }
    const dockerfiles: Record<string, string> = {};
    for (const envDir of tasks.dockerfiles) {
      const key = dockerfileKey(datasetDir, envDir);
      dockerfiles[key] = await build({
        name: `${dataset}/${key}`,
        dockerfile: path.join(envDir, "Dockerfile"),
        context: envDir,
      });
    }
    result.images[dataset] = images;
    result.dockerfiles[dataset] = dockerfiles;
  }
  return result;
};

/** `LMNR_EVAL_IMAGES` for one dataset of a remote run. */
export const datasetImages = (
  remote: RemoteImages,
  dataset: string,
): DatasetImages => ({
  images: remote.images[dataset] ?? {},
  dockerfiles: remote.dockerfiles[dataset] ?? {},
});
