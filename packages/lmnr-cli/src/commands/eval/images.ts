import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidEvalsDir } from "../../errors";
import {
  DATASET_CONFIG,
  findTaskTomls,
  loadDatasetConfig,
  type RunOverrides,
} from "./datasets";
import {
  type EvalDescription,
  evalDescription,
  type GeneratedImage,
  hasEvalPy,
} from "./eval-py";

/** Where images used to be declared; a leftover one only warns. */
export const LEGACY_IMAGES_FILE = "lmnr.yaml";

export interface ImageDef {
  /** Shown in logs and errors; for harbor.yaml images, the `docker_image`. */
  name: string;
  dockerfile: string;
  context: string;
  /**
   * The ignore file to build with, instead of `<Dockerfile>.dockerignore` or
   * the context's `.dockerignore` (a generated image's `ignore_file`).
   */
  ignoreFile?: string;
  /** `dockerfile` is a generated one (`generatedImageDef`). */
  generated?: boolean;
  /**
   * Named build contexts it reads (`--build-context`), e.g. `lmnr-dev` for
   * the Laminar layer's wheel (`layer.ts`).
   */
  buildContexts?: string[];
}

/** BuildKit parser directives: only at the top, and they change the build. */
const PARSER_DIRECTIVE = /^#\s*(syntax|escape|check)\s*=/i;
/** A heredoc start (`<<EOF`, `<<-'EOF'`); its body runs until the delimiter line. */
const HEREDOC = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/**
 * The part of a Dockerfile that decides what is built: comment lines (a
 * generated Dockerfile's provenance) are dropped, except the parser
 * directives at the top and heredoc lines, which are content (a shebang, a
 * written file).
 */
export const dockerfileForHash = (text: string): string => {
  const kept: string[] = [];
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let header = true;
  for (const line of text.split(/\r?\n/)) {
    if (heredocs.length > 0) {
      kept.push(line);
      const { delimiter, tabs } = heredocs[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        heredocs.shift();
      }
      continue;
    }
    if (header && PARSER_DIRECTIVE.test(line)) {
      kept.push(line);
      continue;
    }
    header = false;
    if (line.trimStart().startsWith("#")) continue;
    kept.push(line);
    for (const m of line.matchAll(HEREDOC)) {
      heredocs.push({ delimiter: m[3], tabs: m[1] === "-" });
    }
  }
  return kept.join("\n");
};

/**
 * Generated Dockerfiles are built from `<tmp>/lmnr-generated/<hash>/Dockerfile`,
 * `hash` covering what decides the build: the Dockerfile minus its comments
 * (`dockerfileForHash`), the context, the ignore file's path and content. Two
 * images (or datasets) with one definition get one path, so a run builds and
 * pushes them once, whatever their provenance comments say.
 */
const generatedImageDef = async (
  name: string,
  image: GeneratedImage,
  buildContexts: string[],
): Promise<ImageDef> => {
  const ignoreText = image.ignore_file
    ? await readFile(image.ignore_file, "utf8").catch(() => "")
    : "";
  const hash = createHash("sha256")
    .update(
      [
        dockerfileForHash(image.dockerfile_text),
        image.context,
        image.ignore_file ?? "",
        ignoreText,
      ].join("\0"),
    )
    .digest("hex");
  const dir = path.join(tmpdir(), "lmnr-generated", hash);
  const dockerfile = path.join(dir, "Dockerfile");
  await mkdir(dir, { recursive: true });
  // Written whole, then renamed: another run may be reading the same path.
  const partial = `${dockerfile}.${randomBytes(6).toString("hex")}`;
  await writeFile(partial, image.dockerfile_text);
  await rename(partial, dockerfile);
  return {
    name,
    dockerfile,
    context: image.context,
    ...(image.ignore_file ? { ignoreFile: image.ignore_file } : {}),
    generated: true,
    ...(buildContexts.length > 0 ? { buildContexts } : {}),
  };
};

/** The images an eval.py runner builds: its Dockerfile and generated ones. */
const evalImageDefs = async (
  description: EvalDescription,
): Promise<ImageDef[]> => {
  const defs: ImageDef[] = [];
  for (const [name, image] of Object.entries(description.images)) {
    if (image.kind === "dockerfile") {
      defs.push({ name, dockerfile: image.dockerfile, context: image.context });
    } else if (image.kind === "generated") {
      const contexts = Object.keys(
        description.laminar_layer?.build_contexts ?? {},
      );
      defs.push(await generatedImageDef(name, image, contexts));
    }
  }
  return defs;
};

/** One build per definition: images whose builds this says are the same. */
const buildKey = (def: ImageDef): string =>
  [
    def.dockerfile,
    def.context,
    def.ignoreFile ?? "",
    ...(def.buildContexts ?? []),
  ].join("\0");

/** A generated Dockerfile's file name where runs keep it for review. */
export const generatedDockerfileName = (image: string): string =>
  `${image.replace(/[^A-Za-z0-9._-]/g, "_")}.Dockerfile`;

/** Where a remote run's upload holds them, in each dataset folder. */
export const GENERATED_UPLOAD_DIR = "agent/.generated";

/**
 * The generated Dockerfiles of the images the run's tasks in this eval.py
 * dataset use, by file name (`generatedDockerfileName`), as describe printed
 * them (provenance comments included): runs keep them for review.
 */
export const generatedDockerfiles = async (
  datasetDir: string,
  overrides: RunOverrides,
): Promise<Record<string, string>> => {
  if (!(await hasEvalPy(datasetDir))) return {};
  const used = new Set((await findTaskImages(datasetDir, overrides)).images);
  return Object.fromEntries(
    Object.entries(evalDescription(datasetDir).images).flatMap(
      ([name, image]) =>
        image.kind === "generated" && used.has(name)
          ? [[generatedDockerfileName(name), image.dockerfile_text]]
          : [],
    ),
  );
};

/**
 * Every image a remote run uses, as pushed manifest digests, by dataset (each
 * dataset declares its own in its harbor.yaml or agent/eval.py).
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
 * relative to the dataset dir; for an eval.py dataset, the runner's
 * Dockerfile and generated images (registry images are no build).
 */
export const loadImageDefs = async (
  datasetDir: string,
): Promise<ImageDef[]> => {
  if (await hasEvalPy(datasetDir)) {
    return evalImageDefs(evalDescription(datasetDir));
  }
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
 * The images a local run's tasks start from that lmnr-cli builds (harbor.yaml
 * images, an eval.py runner's Dockerfile and generated ones), each dataset's
 * own, grouped into one entry per build (`buildKey`) with every name to tag it
 * with. Harbor builds per-task Dockerfiles and pulls other images itself.
 * Local builds are tagged with the image's name, so two datasets of one run
 * can't define a name differently (generated ones: differently but for
 * comments).
 */
export const localImageDefs = async (
  evalsDir: string,
  datasets: string[],
  overrides: RunOverrides,
): Promise<LocalBuild[]> => {
  const byName = new Map<string, { key: string; dataset: string }>();
  const builds = new Map<string, LocalBuild>();
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    const used = new Set((await findTaskImages(datasetDir, overrides)).images);
    for (const def of await loadImageDefs(datasetDir)) {
      if (!used.has(def.name)) continue;
      const key = buildKey(def);
      const seen = byName.get(def.name);
      if (seen && seen.key !== key) {
        throw invalidEvalsDir(
          `Image ${def.name} is defined differently by ${seen.dataset} and ` +
            `${dataset}; local builds are tagged by name, so run these ` +
            "datasets separately or rename one image.",
        );
      }
      if (seen) continue;
      byName.set(def.name, { key, dataset });
      const build = builds.get(key);
      if (build) build.tags.push(def.name);
      else builds.set(key, { def, tags: [def.name] });
    }
  }
  return [...builds.values()];
};

/** One local build: `def`, tagged with each name that defines it so. */
export interface LocalBuild {
  def: ImageDef;
  tags: string[];
}

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
 * is pushed once per run: builds by Dockerfile, context and ignore file
 * (generated Dockerfiles by content), pulls by ref; each name it has maps to
 * its digest.
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
    const key = buildKey(def);
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
