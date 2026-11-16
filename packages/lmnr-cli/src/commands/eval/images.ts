import { findTaskDirs, type RunOverrides, readTaskToml } from "./layout";

export interface ImageDef {
  /** Shown in logs and errors; for agent.yaml images, the `docker_image`. */
  name: string;
  dockerfile: string;
  context: string;
}

/**
 * Every image a remote run's tasks use, as pushed manifest digests by
 * `docker_image`. Read by `lmnr_hosted_env.py` from `LMNR_EVAL_IMAGES`.
 */
export interface RemoteImages {
  images: Record<string, string>;
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

/** The `docker_image`s the run's tasks (`--task` applies) start from, each once. */
export const findTaskImages = async (
  setDirs: string[],
  overrides: RunOverrides,
): Promise<string[]> => {
  const images = new Set<string>();
  for (const setDir of setDirs) {
    for (const dir of await findTaskDirs(setDir, overrides.tasks)) {
      const { dockerImage } = await readTaskToml(dir);
      if (dockerImage) images.add(dockerImage);
    }
  }
  return [...images];
};

/** The agent.yaml images a local run's tasks start from; Harbor pulls the rest. */
export const localImageDefs = async (
  defs: ImageDef[],
  setDirs: string[],
  overrides: RunOverrides,
): Promise<ImageDef[]> => {
  const used = new Set(await findTaskImages(setDirs, overrides));
  return defs.filter((def) => used.has(def.name));
};

/**
 * Push every image the run's tasks use, so Laminar sandboxes can start from
 * them: agent.yaml images are built here, other `docker_image`s are pulled.
 */
export const ensureRemoteImages = async (
  defs: ImageDef[],
  setDirs: string[],
  overrides: RunOverrides,
  pusher: ImagePusher,
): Promise<RemoteImages> => {
  const byName = new Map(defs.map((def) => [def.name, def]));
  const images: Record<string, string> = {};
  for (const ref of await findTaskImages(setDirs, overrides)) {
    const def = byName.get(ref);
    images[ref] = def ? await pusher.build(def) : await pusher.pull(ref);
  }
  return { images };
};
